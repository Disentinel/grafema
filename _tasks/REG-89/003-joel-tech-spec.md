# REG-89: Track RFDB Performance Bottlenecks - Technical Specification

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2026-02-06
**Based on:** Don's plan (`002-don-plan.md`)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Structures](#2-data-structures)
3. [Protocol Changes](#3-protocol-changes)
4. [Implementation Changes](#4-implementation-changes)
5. [CLI Changes](#5-cli-changes)
6. [Test Specifications](#6-test-specifications)
7. [Benchmark Extensions](#7-benchmark-extensions)
8. [Constants and Thresholds](#8-constants-and-thresholds)
9. [Complexity Analysis](#9-complexity-analysis)
10. [Error Handling](#10-error-handling)
11. [Implementation Order](#11-implementation-order)

---

## 1. Overview

This specification details the exact code changes needed to add performance metrics tracking to RFDB. The design follows the existing patterns in the codebase:

- **Existing debug pattern:** `eprintln!("[RUST TAG] ...")` with `NAVI_DEBUG` env var
- **Existing slow query pattern:** 50ms threshold in `get_outgoing_edges`
- **Existing memory monitoring:** `check_memory_usage()` via `sysinfo` crate

**Key Design Decisions:**

1. **No external dependencies** - Use atomics and standard library only
2. **Zero-cost when disabled** - Metrics struct is `Option<Arc<Metrics>>`
3. **Thread-safe** - All counters use `AtomicU64`
4. **Protocol additive** - New `GetStats` command, no breaking changes

---

## 2. Data Structures

### 2.1 New File: `src/metrics.rs`

```rust
//! Performance metrics for RFDB server
//!
//! Provides lightweight, thread-safe metrics collection with zero-cost
//! when disabled. Metrics are collected per-server (not per-database)
//! to track overall system performance.
//!
//! # Usage
//!
//! ```no_run
//! use rfdb::metrics::Metrics;
//!
//! let metrics = Metrics::new();
//!
//! // Record a query
//! metrics.record_query("Bfs", 15);  // 15ms BFS query
//!
//! // Get stats
//! let stats = metrics.snapshot();
//! println!("p50: {}ms", stats.query_p50_ms);
//! ```

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use std::collections::VecDeque;

/// Maximum number of query latencies to retain for percentile calculation
const LATENCY_WINDOW_SIZE: usize = 1000;

/// Slow query threshold in milliseconds
pub const SLOW_QUERY_THRESHOLD_MS: u64 = 100;

/// Thread-safe performance metrics collector
pub struct Metrics {
    // ========================================================================
    // Query Metrics
    // ========================================================================

    /// Total number of queries processed
    query_count: AtomicU64,

    /// Number of queries exceeding SLOW_QUERY_THRESHOLD_MS
    slow_query_count: AtomicU64,

    /// Rolling window of recent query latencies (for percentile calculation)
    /// Protected by mutex since VecDeque isn't atomic
    latencies_ms: Mutex<VecDeque<u64>>,

    /// Sum of all latencies in window (for average calculation)
    latency_sum_ms: AtomicU64,

    // ========================================================================
    // Operation Counters (by type)
    // ========================================================================

    /// Count of each operation type
    op_counts: OperationCounters,

    /// Sum of latencies by operation type (for per-op averages)
    op_latency_sums: OperationLatencies,

    // ========================================================================
    // Flush Metrics
    // ========================================================================

    /// Number of flush operations
    flush_count: AtomicU64,

    /// Total time spent in flush operations (ms)
    flush_total_ms: AtomicU64,

    /// Last flush duration (ms)
    last_flush_ms: AtomicU64,

    /// Nodes written in last flush
    last_flush_nodes: AtomicU64,

    /// Edges written in last flush
    last_flush_edges: AtomicU64,

    // ========================================================================
    // Slow Query Tracking
    // ========================================================================

    /// Recent slow queries (operation type, duration_ms)
    /// Limited to last 10 slow queries
    slow_queries: Mutex<VecDeque<SlowQuery>>,

    // ========================================================================
    // Timestamps
    // ========================================================================

    /// When metrics collection started
    started_at: Instant,
}

/// Counters for each operation type
/// Using separate atomics for cache-line efficiency
pub struct OperationCounters {
    pub bfs: AtomicU64,
    pub dfs: AtomicU64,
    pub neighbors: AtomicU64,
    pub reachability: AtomicU64,
    pub find_by_type: AtomicU64,
    pub find_by_attr: AtomicU64,
    pub get_node: AtomicU64,
    pub add_nodes: AtomicU64,
    pub add_edges: AtomicU64,
    pub datalog_query: AtomicU64,
    pub check_guarantee: AtomicU64,
    pub get_outgoing_edges: AtomicU64,
    pub get_incoming_edges: AtomicU64,
    pub other: AtomicU64,
}

/// Latency sums for each operation type (for computing averages)
pub struct OperationLatencies {
    pub bfs: AtomicU64,
    pub dfs: AtomicU64,
    pub neighbors: AtomicU64,
    pub reachability: AtomicU64,
    pub find_by_type: AtomicU64,
    pub find_by_attr: AtomicU64,
    pub get_node: AtomicU64,
    pub add_nodes: AtomicU64,
    pub add_edges: AtomicU64,
    pub datalog_query: AtomicU64,
    pub check_guarantee: AtomicU64,
    pub get_outgoing_edges: AtomicU64,
    pub get_incoming_edges: AtomicU64,
    pub other: AtomicU64,
}

/// A recorded slow query
#[derive(Clone, Debug)]
pub struct SlowQuery {
    pub operation: String,
    pub duration_ms: u64,
    pub timestamp_ms: u64,  // ms since metrics started
}

/// Snapshot of current metrics (for GetStats response)
#[derive(Clone, Debug, Default)]
pub struct MetricsSnapshot {
    // Query stats
    pub query_count: u64,
    pub slow_query_count: u64,
    pub query_p50_ms: u64,
    pub query_p95_ms: u64,
    pub query_p99_ms: u64,
    pub query_avg_ms: u64,

    // Flush stats
    pub flush_count: u64,
    pub flush_avg_ms: u64,
    pub last_flush_ms: u64,
    pub last_flush_nodes: u64,
    pub last_flush_edges: u64,

    // Top slow queries
    pub top_slow_queries: Vec<SlowQuery>,

    // Uptime
    pub uptime_secs: u64,

    // Per-operation averages (top 5 by count)
    pub op_stats: Vec<OperationStat>,
}

/// Statistics for a single operation type
#[derive(Clone, Debug)]
pub struct OperationStat {
    pub operation: String,
    pub count: u64,
    pub avg_ms: u64,
}

impl Default for OperationCounters {
    fn default() -> Self {
        Self {
            bfs: AtomicU64::new(0),
            dfs: AtomicU64::new(0),
            neighbors: AtomicU64::new(0),
            reachability: AtomicU64::new(0),
            find_by_type: AtomicU64::new(0),
            find_by_attr: AtomicU64::new(0),
            get_node: AtomicU64::new(0),
            add_nodes: AtomicU64::new(0),
            add_edges: AtomicU64::new(0),
            datalog_query: AtomicU64::new(0),
            check_guarantee: AtomicU64::new(0),
            get_outgoing_edges: AtomicU64::new(0),
            get_incoming_edges: AtomicU64::new(0),
            other: AtomicU64::new(0),
        }
    }
}

impl Default for OperationLatencies {
    fn default() -> Self {
        Self {
            bfs: AtomicU64::new(0),
            dfs: AtomicU64::new(0),
            neighbors: AtomicU64::new(0),
            reachability: AtomicU64::new(0),
            find_by_type: AtomicU64::new(0),
            find_by_attr: AtomicU64::new(0),
            get_node: AtomicU64::new(0),
            add_nodes: AtomicU64::new(0),
            add_edges: AtomicU64::new(0),
            datalog_query: AtomicU64::new(0),
            check_guarantee: AtomicU64::new(0),
            get_outgoing_edges: AtomicU64::new(0),
            get_incoming_edges: AtomicU64::new(0),
            other: AtomicU64::new(0),
        }
    }
}

impl Metrics {
    /// Create a new metrics collector
    pub fn new() -> Self {
        Self {
            query_count: AtomicU64::new(0),
            slow_query_count: AtomicU64::new(0),
            latencies_ms: Mutex::new(VecDeque::with_capacity(LATENCY_WINDOW_SIZE)),
            latency_sum_ms: AtomicU64::new(0),
            op_counts: OperationCounters::default(),
            op_latency_sums: OperationLatencies::default(),
            flush_count: AtomicU64::new(0),
            flush_total_ms: AtomicU64::new(0),
            last_flush_ms: AtomicU64::new(0),
            last_flush_nodes: AtomicU64::new(0),
            last_flush_edges: AtomicU64::new(0),
            slow_queries: Mutex::new(VecDeque::with_capacity(10)),
            started_at: Instant::now(),
        }
    }

    /// Record a query execution
    ///
    /// # Arguments
    /// * `operation` - Operation type (e.g., "Bfs", "DatalogQuery")
    /// * `duration_ms` - Query duration in milliseconds
    ///
    /// # Complexity
    /// O(1) amortized - atomic increments + bounded deque operations
    pub fn record_query(&self, operation: &str, duration_ms: u64) {
        // Increment total count
        self.query_count.fetch_add(1, Ordering::Relaxed);

        // Update operation-specific counters
        self.increment_op_counter(operation);
        self.add_op_latency(operation, duration_ms);

        // Update latency window (mutex-protected)
        {
            let mut latencies = self.latencies_ms.lock().unwrap();

            // Remove oldest if at capacity
            if latencies.len() >= LATENCY_WINDOW_SIZE {
                if let Some(old) = latencies.pop_front() {
                    self.latency_sum_ms.fetch_sub(old, Ordering::Relaxed);
                }
            }

            latencies.push_back(duration_ms);
            self.latency_sum_ms.fetch_add(duration_ms, Ordering::Relaxed);
        }

        // Track slow queries
        if duration_ms >= SLOW_QUERY_THRESHOLD_MS {
            self.slow_query_count.fetch_add(1, Ordering::Relaxed);

            let slow_query = SlowQuery {
                operation: operation.to_string(),
                duration_ms,
                timestamp_ms: self.started_at.elapsed().as_millis() as u64,
            };

            let mut slow_queries = self.slow_queries.lock().unwrap();
            if slow_queries.len() >= 10 {
                slow_queries.pop_front();
            }
            slow_queries.push_back(slow_query);
        }
    }

    /// Record a flush operation
    pub fn record_flush(&self, duration_ms: u64, nodes_written: u64, edges_written: u64) {
        self.flush_count.fetch_add(1, Ordering::Relaxed);
        self.flush_total_ms.fetch_add(duration_ms, Ordering::Relaxed);
        self.last_flush_ms.store(duration_ms, Ordering::Relaxed);
        self.last_flush_nodes.store(nodes_written, Ordering::Relaxed);
        self.last_flush_edges.store(edges_written, Ordering::Relaxed);
    }

    /// Get a snapshot of current metrics
    ///
    /// # Complexity
    /// O(LATENCY_WINDOW_SIZE) for percentile calculation
    pub fn snapshot(&self) -> MetricsSnapshot {
        let query_count = self.query_count.load(Ordering::Relaxed);
        let slow_query_count = self.slow_query_count.load(Ordering::Relaxed);

        // Calculate percentiles from latency window
        let (p50, p95, p99, avg) = {
            let latencies = self.latencies_ms.lock().unwrap();
            if latencies.is_empty() {
                (0, 0, 0, 0)
            } else {
                let mut sorted: Vec<u64> = latencies.iter().copied().collect();
                sorted.sort_unstable();

                let len = sorted.len();
                let p50 = sorted[len * 50 / 100];
                let p95 = sorted[len * 95 / 100];
                let p99 = sorted.get(len * 99 / 100).copied().unwrap_or(sorted[len - 1]);
                let avg = self.latency_sum_ms.load(Ordering::Relaxed) / len as u64;

                (p50, p95, p99, avg)
            }
        };

        // Flush stats
        let flush_count = self.flush_count.load(Ordering::Relaxed);
        let flush_avg = if flush_count > 0 {
            self.flush_total_ms.load(Ordering::Relaxed) / flush_count
        } else {
            0
        };

        // Slow queries
        let top_slow = {
            let slow = self.slow_queries.lock().unwrap();
            slow.iter().cloned().collect()
        };

        // Per-operation stats (top 5 by count)
        let op_stats = self.get_top_operations(5);

        MetricsSnapshot {
            query_count,
            slow_query_count,
            query_p50_ms: p50,
            query_p95_ms: p95,
            query_p99_ms: p99,
            query_avg_ms: avg,
            flush_count,
            flush_avg_ms: flush_avg,
            last_flush_ms: self.last_flush_ms.load(Ordering::Relaxed),
            last_flush_nodes: self.last_flush_nodes.load(Ordering::Relaxed),
            last_flush_edges: self.last_flush_edges.load(Ordering::Relaxed),
            top_slow_queries: top_slow,
            uptime_secs: self.started_at.elapsed().as_secs(),
            op_stats,
        }
    }

    /// Increment the counter for a specific operation type
    fn increment_op_counter(&self, operation: &str) {
        let counter = match operation {
            "Bfs" => &self.op_counts.bfs,
            "Dfs" => &self.op_counts.dfs,
            "Neighbors" => &self.op_counts.neighbors,
            "Reachability" => &self.op_counts.reachability,
            "FindByType" => &self.op_counts.find_by_type,
            "FindByAttr" => &self.op_counts.find_by_attr,
            "GetNode" => &self.op_counts.get_node,
            "AddNodes" => &self.op_counts.add_nodes,
            "AddEdges" => &self.op_counts.add_edges,
            "DatalogQuery" => &self.op_counts.datalog_query,
            "CheckGuarantee" => &self.op_counts.check_guarantee,
            "GetOutgoingEdges" => &self.op_counts.get_outgoing_edges,
            "GetIncomingEdges" => &self.op_counts.get_incoming_edges,
            _ => &self.op_counts.other,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    /// Add latency to a specific operation type
    fn add_op_latency(&self, operation: &str, duration_ms: u64) {
        let latency = match operation {
            "Bfs" => &self.op_latency_sums.bfs,
            "Dfs" => &self.op_latency_sums.dfs,
            "Neighbors" => &self.op_latency_sums.neighbors,
            "Reachability" => &self.op_latency_sums.reachability,
            "FindByType" => &self.op_latency_sums.find_by_type,
            "FindByAttr" => &self.op_latency_sums.find_by_attr,
            "GetNode" => &self.op_latency_sums.get_node,
            "AddNodes" => &self.op_latency_sums.add_nodes,
            "AddEdges" => &self.op_latency_sums.add_edges,
            "DatalogQuery" => &self.op_latency_sums.datalog_query,
            "CheckGuarantee" => &self.op_latency_sums.check_guarantee,
            "GetOutgoingEdges" => &self.op_latency_sums.get_outgoing_edges,
            "GetIncomingEdges" => &self.op_latency_sums.get_incoming_edges,
            _ => &self.op_latency_sums.other,
        };
        latency.fetch_add(duration_ms, Ordering::Relaxed);
    }

    /// Get top N operations by count with their average latencies
    fn get_top_operations(&self, n: usize) -> Vec<OperationStat> {
        let ops = vec![
            ("Bfs", self.op_counts.bfs.load(Ordering::Relaxed), self.op_latency_sums.bfs.load(Ordering::Relaxed)),
            ("Dfs", self.op_counts.dfs.load(Ordering::Relaxed), self.op_latency_sums.dfs.load(Ordering::Relaxed)),
            ("Neighbors", self.op_counts.neighbors.load(Ordering::Relaxed), self.op_latency_sums.neighbors.load(Ordering::Relaxed)),
            ("Reachability", self.op_counts.reachability.load(Ordering::Relaxed), self.op_latency_sums.reachability.load(Ordering::Relaxed)),
            ("FindByType", self.op_counts.find_by_type.load(Ordering::Relaxed), self.op_latency_sums.find_by_type.load(Ordering::Relaxed)),
            ("FindByAttr", self.op_counts.find_by_attr.load(Ordering::Relaxed), self.op_latency_sums.find_by_attr.load(Ordering::Relaxed)),
            ("GetNode", self.op_counts.get_node.load(Ordering::Relaxed), self.op_latency_sums.get_node.load(Ordering::Relaxed)),
            ("AddNodes", self.op_counts.add_nodes.load(Ordering::Relaxed), self.op_latency_sums.add_nodes.load(Ordering::Relaxed)),
            ("AddEdges", self.op_counts.add_edges.load(Ordering::Relaxed), self.op_latency_sums.add_edges.load(Ordering::Relaxed)),
            ("DatalogQuery", self.op_counts.datalog_query.load(Ordering::Relaxed), self.op_latency_sums.datalog_query.load(Ordering::Relaxed)),
            ("CheckGuarantee", self.op_counts.check_guarantee.load(Ordering::Relaxed), self.op_latency_sums.check_guarantee.load(Ordering::Relaxed)),
            ("GetOutgoingEdges", self.op_counts.get_outgoing_edges.load(Ordering::Relaxed), self.op_latency_sums.get_outgoing_edges.load(Ordering::Relaxed)),
            ("GetIncomingEdges", self.op_counts.get_incoming_edges.load(Ordering::Relaxed), self.op_latency_sums.get_incoming_edges.load(Ordering::Relaxed)),
        ];

        let mut stats: Vec<_> = ops.into_iter()
            .filter(|(_, count, _)| *count > 0)
            .map(|(name, count, latency_sum)| OperationStat {
                operation: name.to_string(),
                count,
                avg_ms: if count > 0 { latency_sum / count } else { 0 },
            })
            .collect();

        stats.sort_by(|a, b| b.count.cmp(&a.count));
        stats.truncate(n);
        stats
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}
```

### 2.2 Wire Protocol Types for Stats

Add to `rfdb_server.rs` Response enum:

```rust
/// Performance statistics response
Stats {
    // Graph size
    #[serde(rename = "nodeCount")]
    node_count: u64,
    #[serde(rename = "edgeCount")]
    edge_count: u64,
    #[serde(rename = "deltaSize")]
    delta_size: u64,

    // Memory (system)
    #[serde(rename = "memoryPercent")]
    memory_percent: f32,

    // Query latency
    #[serde(rename = "queryCount")]
    query_count: u64,
    #[serde(rename = "slowQueryCount")]
    slow_query_count: u64,
    #[serde(rename = "queryP50Ms")]
    query_p50_ms: u64,
    #[serde(rename = "queryP95Ms")]
    query_p95_ms: u64,
    #[serde(rename = "queryP99Ms")]
    query_p99_ms: u64,

    // Flush stats
    #[serde(rename = "flushCount")]
    flush_count: u64,
    #[serde(rename = "lastFlushMs")]
    last_flush_ms: u64,
    #[serde(rename = "lastFlushNodes")]
    last_flush_nodes: u64,
    #[serde(rename = "lastFlushEdges")]
    last_flush_edges: u64,

    // Top slow queries
    #[serde(rename = "topSlowQueries")]
    top_slow_queries: Vec<WireSlowQuery>,

    // Uptime
    #[serde(rename = "uptimeSecs")]
    uptime_secs: u64,
},
```

Add slow query wire type:

```rust
/// Slow query info for wire protocol
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireSlowQuery {
    pub operation: String,
    pub duration_ms: u64,
    pub timestamp_ms: u64,
}
```

---

## 3. Protocol Changes

### 3.1 New Request Variant

Add to `Request` enum in `rfdb_server.rs`:

```rust
/// Get server performance statistics
///
/// Returns metrics about query latency, memory usage, and graph size.
/// Metrics are collected server-wide, not per-database.
GetStats,
```

### 3.2 Request Handler

Add case in `handle_request()`:

```rust
Request::GetStats => {
    // Collect stats from all sources
    let metrics_snapshot = if let Some(ref m) = metrics {
        m.snapshot()
    } else {
        MetricsSnapshot::default()
    };

    // Get graph stats from current database (if any)
    let (node_count, edge_count, delta_size) = if let Some(ref db) = session.current_db {
        let engine = db.engine.read().unwrap();
        (
            engine.node_count() as u64,
            engine.edge_count() as u64,
            engine.ops_since_flush as u64,
        )
    } else {
        // No database selected - return zeros
        (0, 0, 0)
    };

    // Get system memory
    let memory_percent = check_memory_usage();

    Response::Stats {
        node_count,
        edge_count,
        delta_size,
        memory_percent,
        query_count: metrics_snapshot.query_count,
        slow_query_count: metrics_snapshot.slow_query_count,
        query_p50_ms: metrics_snapshot.query_p50_ms,
        query_p95_ms: metrics_snapshot.query_p95_ms,
        query_p99_ms: metrics_snapshot.query_p99_ms,
        flush_count: metrics_snapshot.flush_count,
        last_flush_ms: metrics_snapshot.last_flush_ms,
        last_flush_nodes: metrics_snapshot.last_flush_nodes,
        last_flush_edges: metrics_snapshot.last_flush_edges,
        top_slow_queries: metrics_snapshot.top_slow_queries.into_iter()
            .map(|sq| WireSlowQuery {
                operation: sq.operation,
                duration_ms: sq.duration_ms,
                timestamp_ms: sq.timestamp_ms,
            })
            .collect(),
        uptime_secs: metrics_snapshot.uptime_secs,
    }
}
```

---

## 4. Implementation Changes

### 4.1 Add Metrics Module to lib.rs

```rust
// In src/lib.rs, add:
pub mod metrics;

// And re-export:
pub use metrics::{Metrics, MetricsSnapshot, SLOW_QUERY_THRESHOLD_MS};
```

### 4.2 Modify rfdb_server.rs - Add Metrics to Server

**Step 1: Add imports**

```rust
// At top of rfdb_server.rs
use rfdb::metrics::{Metrics, MetricsSnapshot, SLOW_QUERY_THRESHOLD_MS};
use std::sync::Arc;
use std::time::Instant;
```

**Step 2: Add metrics to main()**

```rust
fn main() {
    // ... existing arg parsing ...

    // === ADD THIS: Create metrics collector ===
    let metrics_enabled = args.iter().any(|a| a == "--metrics");
    let metrics: Option<Arc<Metrics>> = if metrics_enabled {
        eprintln!("[rfdb-server] Metrics collection enabled");
        Some(Arc::new(Metrics::new()))
    } else {
        None
    };

    // ... existing DatabaseManager creation ...

    // === MODIFY: Pass metrics to handle_client ===
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::SeqCst);
                let manager_clone = Arc::clone(&manager);
                let metrics_clone = metrics.clone();  // Clone Arc
                thread::spawn(move || {
                    handle_client(stream, manager_clone, client_id, true, metrics_clone);
                });
            }
            // ...
        }
    }
}
```

**Step 3: Modify handle_client() signature**

```rust
fn handle_client(
    mut stream: UnixStream,
    manager: Arc<DatabaseManager>,
    client_id: usize,
    legacy_mode: bool,
    metrics: Option<Arc<Metrics>>,  // ADD THIS
) {
    // ... existing code ...

    loop {
        // ... message reading ...

        // === ADD: Timing wrapper ===
        let start = Instant::now();
        let op_name = get_operation_name(&request);

        let response = handle_request(&manager, &mut session, request, &metrics);

        // === ADD: Record metrics ===
        if let Some(ref m) = metrics {
            let duration_ms = start.elapsed().as_millis() as u64;
            m.record_query(&op_name, duration_ms);

            // Log slow queries to stderr (existing pattern)
            if duration_ms >= SLOW_QUERY_THRESHOLD_MS {
                eprintln!("[RUST SLOW] {}: {}ms (client {})",
                         op_name, duration_ms, client_id);
            }
        }

        // ... rest of existing code ...
    }
}
```

**Step 4: Add operation name helper**

```rust
/// Get operation name for metrics tracking
fn get_operation_name(request: &Request) -> String {
    match request {
        Request::Bfs { .. } => "Bfs".to_string(),
        Request::Dfs { .. } => "Dfs".to_string(),
        Request::Neighbors { .. } => "Neighbors".to_string(),
        Request::Reachability { .. } => "Reachability".to_string(),
        Request::FindByType { .. } => "FindByType".to_string(),
        Request::FindByAttr { .. } => "FindByAttr".to_string(),
        Request::GetNode { .. } => "GetNode".to_string(),
        Request::AddNodes { .. } => "AddNodes".to_string(),
        Request::AddEdges { .. } => "AddEdges".to_string(),
        Request::DatalogQuery { .. } => "DatalogQuery".to_string(),
        Request::CheckGuarantee { .. } => "CheckGuarantee".to_string(),
        Request::GetOutgoingEdges { .. } => "GetOutgoingEdges".to_string(),
        Request::GetIncomingEdges { .. } => "GetIncomingEdges".to_string(),
        Request::Flush => "Flush".to_string(),
        Request::Compact => "Compact".to_string(),
        Request::NodeCount => "NodeCount".to_string(),
        Request::EdgeCount => "EdgeCount".to_string(),
        _ => "Other".to_string(),
    }
}
```

**Step 5: Modify handle_request() to accept metrics**

```rust
fn handle_request(
    manager: &DatabaseManager,
    session: &mut ClientSession,
    request: Request,
    metrics: &Option<Arc<Metrics>>,  // ADD THIS
) -> Response {
    // Existing implementation unchanged except for GetStats case
    match request {
        Request::GetStats => {
            // Implementation from Section 3.2
        }
        // ... all other cases unchanged ...
    }
}
```

### 4.3 Instrument Flush Operations

In `src/graph/engine.rs`, modify `flush()`:

```rust
fn flush(&mut self) -> Result<()> {
    if self.delta_log.is_empty() {
        return Ok(());
    }

    let start = std::time::Instant::now();  // ADD THIS

    // ... existing flush implementation ...

    let duration_ms = start.elapsed().as_millis() as u64;  // ADD THIS
    let nodes_written = all_nodes.len() as u64;  // Already available
    let edges_written = all_edges.len() as u64;  // Already available

    // Log flush timing (existing pattern enhancement)
    eprintln!("[RUST FLUSH] Completed in {}ms: {} nodes, {} edges",
              duration_ms, nodes_written, edges_written);

    // Note: Metrics recording happens at server level, not engine level
    // The engine doesn't have access to the Metrics instance

    Ok(())
}
```

---

## 5. CLI Changes

### 5.1 Add --metrics Flag to Help Text

Update the help message in `main()`:

```rust
println!("Flags:");
println!("  -V, --version  Print version information");
println!("  -h, --help     Print this help message");
println!("  --metrics      Enable performance metrics collection");  // ADD
```

### 5.2 Update Usage Message

```rust
eprintln!("Usage: rfdb-server <db-path> [--socket <socket-path>] [--data-dir <dir>] [--metrics]");
```

---

## 6. Test Specifications

### 6.1 Unit Tests for Metrics

**File:** `src/metrics.rs` (at bottom of file)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_new() {
        let m = Metrics::new();
        let snap = m.snapshot();

        assert_eq!(snap.query_count, 0);
        assert_eq!(snap.slow_query_count, 0);
    }

    #[test]
    fn test_record_query_increments_count() {
        let m = Metrics::new();

        m.record_query("Bfs", 10);
        m.record_query("Bfs", 20);
        m.record_query("Neighbors", 5);

        let snap = m.snapshot();
        assert_eq!(snap.query_count, 3);
    }

    #[test]
    fn test_slow_query_tracking() {
        let m = Metrics::new();

        // Below threshold
        m.record_query("Bfs", 50);
        m.record_query("Bfs", 99);

        let snap = m.snapshot();
        assert_eq!(snap.slow_query_count, 0);

        // At threshold
        m.record_query("Bfs", 100);
        let snap = m.snapshot();
        assert_eq!(snap.slow_query_count, 1);

        // Above threshold
        m.record_query("DatalogQuery", 500);
        let snap = m.snapshot();
        assert_eq!(snap.slow_query_count, 2);
    }

    #[test]
    fn test_percentile_calculation() {
        let m = Metrics::new();

        // Add 100 queries with latencies 1-100ms
        for i in 1..=100 {
            m.record_query("Test", i);
        }

        let snap = m.snapshot();
        assert_eq!(snap.query_p50_ms, 50);
        assert_eq!(snap.query_p95_ms, 95);
        assert_eq!(snap.query_p99_ms, 99);
    }

    #[test]
    fn test_latency_window_eviction() {
        let m = Metrics::new();

        // Fill window with 1000 queries of 10ms
        for _ in 0..1000 {
            m.record_query("Test", 10);
        }

        // Add 1000 more of 20ms (should evict old ones)
        for _ in 0..1000 {
            m.record_query("Test", 20);
        }

        let snap = m.snapshot();
        // All queries in window should now be 20ms
        assert_eq!(snap.query_p50_ms, 20);
        assert_eq!(snap.query_count, 2000);
    }

    #[test]
    fn test_flush_recording() {
        let m = Metrics::new();

        m.record_flush(100, 5000, 10000);
        m.record_flush(200, 3000, 6000);

        let snap = m.snapshot();
        assert_eq!(snap.flush_count, 2);
        assert_eq!(snap.flush_avg_ms, 150);
        assert_eq!(snap.last_flush_ms, 200);
        assert_eq!(snap.last_flush_nodes, 3000);
        assert_eq!(snap.last_flush_edges, 6000);
    }

    #[test]
    fn test_operation_specific_counters() {
        let m = Metrics::new();

        m.record_query("Bfs", 10);
        m.record_query("Bfs", 20);
        m.record_query("DatalogQuery", 100);

        let snap = m.snapshot();

        // Find Bfs in op_stats
        let bfs_stat = snap.op_stats.iter().find(|s| s.operation == "Bfs");
        assert!(bfs_stat.is_some());
        assert_eq!(bfs_stat.unwrap().count, 2);
        assert_eq!(bfs_stat.unwrap().avg_ms, 15);
    }

    #[test]
    fn test_slow_queries_limited_to_10() {
        let m = Metrics::new();

        // Record 15 slow queries
        for i in 0..15 {
            m.record_query("Slow", 100 + i);
        }

        let snap = m.snapshot();
        assert_eq!(snap.top_slow_queries.len(), 10);

        // Should have the most recent 10 (100+5 through 100+14)
        assert_eq!(snap.top_slow_queries[0].duration_ms, 105);
        assert_eq!(snap.top_slow_queries[9].duration_ms, 114);
    }

    #[test]
    fn test_thread_safety() {
        use std::thread;

        let m = Arc::new(Metrics::new());
        let mut handles = vec![];

        // Spawn 10 threads each recording 100 queries
        for _ in 0..10 {
            let m_clone = Arc::clone(&m);
            handles.push(thread::spawn(move || {
                for _ in 0..100 {
                    m_clone.record_query("Test", 10);
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        let snap = m.snapshot();
        assert_eq!(snap.query_count, 1000);
    }
}
```

### 6.2 Integration Tests for GetStats Command

**File:** `src/bin/rfdb_server.rs` (in existing `protocol_tests` module)

```rust
#[test]
fn test_get_stats_no_database() {
    let (_dir, manager) = setup_test_manager();
    let mut session = ClientSession::new(1);
    let metrics = Some(Arc::new(Metrics::new()));

    // Record some queries
    metrics.as_ref().unwrap().record_query("Bfs", 50);
    metrics.as_ref().unwrap().record_query("Bfs", 150);  // slow

    let response = handle_request(&manager, &mut session, Request::GetStats, &metrics);

    match response {
        Response::Stats {
            query_count, slow_query_count, node_count, edge_count, ..
        } => {
            assert_eq!(query_count, 2);
            assert_eq!(slow_query_count, 1);
            // No database selected
            assert_eq!(node_count, 0);
            assert_eq!(edge_count, 0);
        }
        _ => panic!("Expected Stats response"),
    }
}

#[test]
fn test_get_stats_with_database() {
    let (_dir, manager) = setup_test_manager();
    let mut session = ClientSession::new(1);
    let metrics = Some(Arc::new(Metrics::new()));

    // Open default database
    handle_request(&manager, &mut session, Request::OpenDatabase {
        name: "default".to_string(),
        mode: "rw".to_string(),
    }, &metrics);

    // Add some nodes
    handle_request(&manager, &mut session, Request::AddNodes {
        nodes: vec![WireNode {
            id: "1".to_string(),
            node_type: Some("TEST".to_string()),
            name: Some("test".to_string()),
            file: None,
            exported: false,
            metadata: None,
        }],
    }, &metrics);

    let response = handle_request(&manager, &mut session, Request::GetStats, &metrics);

    match response {
        Response::Stats { node_count, .. } => {
            assert_eq!(node_count, 1);
        }
        _ => panic!("Expected Stats response"),
    }
}

#[test]
fn test_get_stats_metrics_disabled() {
    let (_dir, manager) = setup_test_manager();
    let mut session = ClientSession::new(1);
    let metrics: Option<Arc<Metrics>> = None;  // Disabled

    let response = handle_request(&manager, &mut session, Request::GetStats, &metrics);

    match response {
        Response::Stats { query_count, .. } => {
            // Should return zeros when metrics disabled
            assert_eq!(query_count, 0);
        }
        _ => panic!("Expected Stats response"),
    }
}
```

---

## 7. Benchmark Extensions

### 7.1 New Benchmarks

**File:** `benches/graph_operations.rs` (add to existing file)

```rust
fn bench_datalog_query(c: &mut Criterion) {
    use rfdb::datalog::{parse_program, Evaluator};

    let mut group = c.benchmark_group("datalog_query");

    for size in [1000, 10000] {
        let (_dir, engine) = create_test_graph(size, size * 2);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                // Simple query: find all FUNCTION nodes
                let evaluator = Evaluator::new(&engine);
                let results = evaluator.query(&rfdb::datalog::parse_atom("node(X, \"FUNCTION\")").unwrap());
                black_box(results);
            });
        });
    }

    group.finish();
}

fn bench_reachability(c: &mut Criterion) {
    let mut group = c.benchmark_group("reachability");

    for size in [100, 1000, 10000] {
        let (_dir, engine) = create_test_graph(size, size * 3);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.reachability(
                    black_box(&[0]),
                    10,
                    &["CALLS"],
                    false,  // forward
                );
                black_box(result);
            });
        });
    }

    group.finish();
}

fn bench_reachability_backward(c: &mut Criterion) {
    let mut group = c.benchmark_group("reachability_backward");

    for size in [100, 1000, 10000] {
        let (_dir, engine) = create_test_graph(size, size * 3);

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                let result = engine.reachability(
                    black_box(&[50]),  // Start from middle
                    10,
                    &["CALLS"],
                    true,  // backward
                );
                black_box(result);
            });
        });
    }

    group.finish();
}

fn bench_flush(c: &mut Criterion) {
    let mut group = c.benchmark_group("flush");

    for size in [1000, 10000, 50000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter(|| {
                let dir = TempDir::new().unwrap();
                let mut engine = GraphEngine::create(dir.path()).unwrap();

                // Add nodes
                let nodes: Vec<NodeRecord> = (0..size)
                    .map(|i| NodeRecord {
                        id: i as u128,
                        node_type: Some("FUNCTION".to_string()),
                        file_id: (i % 100) as u32,
                        name_offset: i as u32,
                        version: "main".to_string(),
                        exported: false,
                        replaces: None,
                        deleted: false,
                        name: Some(format!("func_{}", i)),
                        file: Some(format!("src/file_{}.js", i % 100)),
                        metadata: None,
                    })
                    .collect();

                engine.add_nodes(nodes);

                // Measure flush
                black_box(engine.flush().unwrap());
            });
        });
    }

    group.finish();
}

// Update criterion_group to include new benchmarks
criterion_group!(
    benches,
    bench_add_nodes,
    bench_find_by_type,
    bench_find_by_attr,
    bench_bfs,
    bench_neighbors,
    bench_datalog_query,      // NEW
    bench_reachability,       // NEW
    bench_reachability_backward,  // NEW
    bench_flush,              // NEW
);
```

---

## 8. Constants and Thresholds

| Constant | Value | Location | Rationale |
|----------|-------|----------|-----------|
| `SLOW_QUERY_THRESHOLD_MS` | 100 | `src/metrics.rs` | Higher than existing 50ms to focus on seriously slow queries |
| `LATENCY_WINDOW_SIZE` | 1000 | `src/metrics.rs` | Enough for percentile accuracy, bounded memory |
| `MAX_SLOW_QUERIES` | 10 | `src/metrics.rs` | Keep recent slow queries without unbounded growth |
| `MEMORY_THRESHOLD_PERCENT` | 80.0 | `src/graph/engine.rs` | Existing, unchanged |

---

## 9. Complexity Analysis

### 9.1 Per-Operation Overhead

| Operation | Complexity | Details |
|-----------|------------|---------|
| `record_query()` | O(1) amortized | Atomic increments + bounded deque push |
| `record_flush()` | O(1) | Atomic stores |
| `snapshot()` | O(LATENCY_WINDOW_SIZE) = O(1000) | Sort for percentiles |
| `get_operation_name()` | O(1) | Pattern match |

### 9.2 Memory Overhead

| Data Structure | Size | Formula |
|----------------|------|---------|
| Latency window | 8 KB | 1000 * 8 bytes (u64) |
| Slow query buffer | ~1 KB | 10 * ~100 bytes per SlowQuery |
| Operation counters | 224 bytes | 14 operations * 16 bytes (2 atomics) |
| Total overhead | ~10 KB | Fixed, does not grow with graph size |

### 9.3 Impact on Request Handling

- **When metrics disabled:** Zero overhead (None check is branch-predicted)
- **When metrics enabled:** ~100ns per request (atomic ops + time measurement)
- **Percentile calculation:** ~10µs per snapshot (done only on GetStats)

---

## 10. Error Handling

### 10.1 Metrics Collection Errors

Metrics collection is designed to never fail or block:

1. **Mutex contention:** Uses `Mutex::lock().unwrap()` - poison on panic is acceptable since metrics are non-critical
2. **Overflow:** Counters use `u64` - overflow after 584 billion years at 1M ops/sec
3. **Memory:** Fixed-size buffers prevent unbounded growth

### 10.2 GetStats Error Cases

| Scenario | Behavior |
|----------|----------|
| No database selected | Return zeros for graph size, valid metrics |
| Metrics disabled | Return all zeros |
| Lock poison (panic in another thread) | Panic (acceptable for non-critical) |

---

## 11. Implementation Order

### Phase 1: Metrics Infrastructure (2-3 hours)

1. Create `src/metrics.rs` with `Metrics` struct and tests
2. Add `pub mod metrics` to `lib.rs`
3. Run unit tests: `cargo test metrics`

### Phase 2: Protocol Changes (1-2 hours)

1. Add `GetStats` to `Request` enum
2. Add `Stats` to `Response` enum
3. Add `WireSlowQuery` struct
4. Add request handler case

### Phase 3: Server Integration (2-3 hours)

1. Add `--metrics` flag parsing
2. Create `Metrics` instance in `main()`
3. Pass metrics to `handle_client()`
4. Modify `handle_client()` to time requests
5. Add `get_operation_name()` helper
6. Update `handle_request()` signature

### Phase 4: Tests (2 hours)

1. Add integration tests for `GetStats` command
2. Verify slow query logging
3. Test metrics disabled path

### Phase 5: Benchmarks (1-2 hours)

1. Add new benchmark functions
2. Run full benchmark suite
3. Document baseline results

---

## Appendix: Files to Modify

| File | Changes |
|------|---------|
| `src/lib.rs` | Add `pub mod metrics;` |
| `src/metrics.rs` | NEW FILE - all metrics infrastructure |
| `src/bin/rfdb_server.rs` | Add GetStats, timing, --metrics flag |
| `benches/graph_operations.rs` | Add new benchmarks |

**Total Lines of Code:**
- New: ~500 (metrics.rs)
- Modified: ~100 (rfdb_server.rs)
- Tests: ~200
- Benchmarks: ~100

**Estimated Total: 9-13 hours**
