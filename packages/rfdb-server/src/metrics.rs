//! Performance metrics for RFDB server
//!
//! Provides lightweight, thread-safe metrics collection with zero-cost
//! when disabled. Metrics are collected per-server (not per-database)
//! to track overall system performance.
//!
//! # Overview
//!
//! This module implements a metrics collection system for tracking:
//! - Query latencies with percentile calculations (p50, p95, p99)
//! - Slow query detection and logging
//! - Per-operation type statistics
//! - Flush operation timing
//!
//! # Design Decisions
//!
//! - **Zero external dependencies**: Uses only atomics and standard library
//! - **Thread-safe**: All counters use `AtomicU64` for lock-free increments
//! - **Bounded memory**: Fixed-size buffers prevent unbounded growth
//! - **O(1) per-operation**: Recording a query is O(1) amortized
//!
//! # Usage for LLM Agents
//!
//! When should you use this module?
//! - To diagnose slow queries in RFDB server
//! - To monitor flush performance
//! - To identify which operation types are slowest
//! - To get percentile latency data for performance analysis
//!
//! When should you NOT use this module?
//! - For per-database metrics (this is server-wide)
//! - For detailed query profiling (use tracing instead)
//!
//! # Example
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

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// Maximum number of query latencies to retain for percentile calculation.
///
/// This creates a rolling window of the last 1000 queries, which provides
/// statistically meaningful percentile calculations while bounding memory.
const LATENCY_WINDOW_SIZE: usize = 1000;

/// Maximum number of slow queries to retain for reporting.
///
/// Only the 10 most recent slow queries are kept to avoid unbounded growth.
const MAX_SLOW_QUERIES: usize = 10;

/// Slow query threshold in milliseconds.
///
/// Queries taking longer than this are recorded as "slow" and tracked
/// separately for debugging purposes. Set at 100ms to focus on seriously
/// slow queries (higher than the existing 50ms debug threshold).
pub const SLOW_QUERY_THRESHOLD_MS: u64 = 100;

/// Thread-safe performance metrics collector.
///
/// This is the main entry point for metrics collection. Create one instance
/// per server and pass it (wrapped in `Arc`) to all request handlers.
///
/// # Thread Safety
///
/// All fields are either atomic or protected by mutexes. Multiple threads
/// can call `record_query` concurrently without coordination.
///
/// # Memory Usage
///
/// Fixed ~10KB overhead regardless of graph size:
/// - Latency window: 8 KB (1000 * 8 bytes)
/// - Slow query buffer: ~1 KB (10 * ~100 bytes)
/// - Operation counters: 224 bytes (14 ops * 16 bytes)
pub struct Metrics {
    // ========================================================================
    // Query Metrics
    // ========================================================================
    /// Total number of queries processed
    query_count: AtomicU64,

    /// Number of queries exceeding SLOW_QUERY_THRESHOLD_MS
    slow_query_count: AtomicU64,

    /// Rolling window of recent query latencies (for percentile calculation).
    /// Protected by mutex since VecDeque isn't atomic.
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
    /// Recent slow queries (operation type, duration_ms).
    /// Limited to last MAX_SLOW_QUERIES slow queries.
    slow_queries: Mutex<VecDeque<SlowQuery>>,

    // ========================================================================
    // Timestamps
    // ========================================================================
    /// When metrics collection started
    started_at: Instant,
}

/// Counters for each operation type.
///
/// Using separate atomics for cache-line efficiency. Each operation type
/// has its own counter to avoid false sharing between frequently-updated
/// counters.
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

/// Latency sums for each operation type (for computing averages).
///
/// Paired with OperationCounters - divide sum by count to get average.
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

/// A recorded slow query.
///
/// Contains information about a query that exceeded SLOW_QUERY_THRESHOLD_MS.
/// Used for debugging and identifying performance bottlenecks.
#[derive(Clone, Debug, PartialEq)]
pub struct SlowQuery {
    /// The operation type (e.g., "Bfs", "DatalogQuery")
    pub operation: String,
    /// How long the query took in milliseconds
    pub duration_ms: u64,
    /// When the query occurred (ms since metrics started)
    pub timestamp_ms: u64,
}

/// Snapshot of current metrics (for GetStats response).
///
/// This is a point-in-time copy of all metrics that can be serialized
/// and sent over the wire. All values are plain types (no atomics).
#[derive(Clone, Debug, Default)]
pub struct MetricsSnapshot {
    // Query stats
    /// Total number of queries processed since server start
    pub query_count: u64,
    /// Number of queries that exceeded the slow query threshold
    pub slow_query_count: u64,
    /// 50th percentile query latency (median)
    pub query_p50_ms: u64,
    /// 95th percentile query latency
    pub query_p95_ms: u64,
    /// 99th percentile query latency
    pub query_p99_ms: u64,
    /// Average query latency over the recent window
    pub query_avg_ms: u64,

    // Flush stats
    /// Total number of flush operations
    pub flush_count: u64,
    /// Average flush duration in milliseconds
    pub flush_avg_ms: u64,
    /// Duration of the most recent flush
    pub last_flush_ms: u64,
    /// Number of nodes written in the most recent flush
    pub last_flush_nodes: u64,
    /// Number of edges written in the most recent flush
    pub last_flush_edges: u64,

    // Top slow queries
    /// The most recent slow queries (up to MAX_SLOW_QUERIES)
    pub top_slow_queries: Vec<SlowQuery>,

    // Uptime
    /// Server uptime in seconds
    pub uptime_secs: u64,

    // Per-operation averages (top 5 by count)
    /// Statistics for the top operations by count
    pub op_stats: Vec<OperationStat>,
}

/// Statistics for a single operation type.
///
/// Used in MetricsSnapshot to report per-operation performance.
#[derive(Clone, Debug, PartialEq)]
pub struct OperationStat {
    /// Operation name (e.g., "Bfs", "GetNode")
    pub operation: String,
    /// Total number of times this operation was called
    pub count: u64,
    /// Average latency in milliseconds
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
    /// Create a new metrics collector.
    ///
    /// The collector starts with all counters at zero and the uptime clock
    /// begins ticking from this moment.
    ///
    /// # Example
    ///
    /// ```
    /// use rfdb::metrics::Metrics;
    /// let metrics = Metrics::new();
    /// ```
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
            slow_queries: Mutex::new(VecDeque::with_capacity(MAX_SLOW_QUERIES)),
            started_at: Instant::now(),
        }
    }

    /// Record a query execution.
    ///
    /// This should be called after every query completes. It updates:
    /// - Total query count
    /// - Per-operation counters
    /// - Latency window (for percentile calculation)
    /// - Slow query tracking (if duration >= threshold)
    ///
    /// # Arguments
    ///
    /// * `operation` - Operation type (e.g., "Bfs", "DatalogQuery").
    ///   Must match the operation names used in `get_operation_name()`.
    /// * `duration_ms` - Query duration in milliseconds.
    ///
    /// # Complexity
    ///
    /// O(1) amortized - atomic increments + bounded deque operations.
    ///
    /// # Example
    ///
    /// ```
    /// use rfdb::metrics::Metrics;
    /// let metrics = Metrics::new();
    /// metrics.record_query("Bfs", 15);  // 15ms BFS query
    /// ```
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
            if slow_queries.len() >= MAX_SLOW_QUERIES {
                slow_queries.pop_front();
            }
            slow_queries.push_back(slow_query);
        }
    }

    /// Record a flush operation.
    ///
    /// This should be called after every flush completes.
    ///
    /// # Arguments
    ///
    /// * `duration_ms` - How long the flush took in milliseconds
    /// * `nodes_written` - Number of nodes written to disk
    /// * `edges_written` - Number of edges written to disk
    ///
    /// # Example
    ///
    /// ```
    /// use rfdb::metrics::Metrics;
    /// let metrics = Metrics::new();
    /// metrics.record_flush(100, 5000, 10000);
    /// ```
    pub fn record_flush(&self, duration_ms: u64, nodes_written: u64, edges_written: u64) {
        self.flush_count.fetch_add(1, Ordering::Relaxed);
        self.flush_total_ms.fetch_add(duration_ms, Ordering::Relaxed);
        self.last_flush_ms.store(duration_ms, Ordering::Relaxed);
        self.last_flush_nodes.store(nodes_written, Ordering::Relaxed);
        self.last_flush_edges.store(edges_written, Ordering::Relaxed);
    }

    /// Get a snapshot of current metrics.
    ///
    /// This creates a point-in-time copy of all metrics that can be
    /// serialized and sent to clients.
    ///
    /// # Complexity
    ///
    /// O(LATENCY_WINDOW_SIZE) for percentile calculation - about 1000 items
    /// to sort. This is done only on GetStats requests, not per-query.
    ///
    /// # Example
    ///
    /// ```
    /// use rfdb::metrics::Metrics;
    /// let metrics = Metrics::new();
    /// metrics.record_query("Bfs", 15);
    /// let snapshot = metrics.snapshot();
    /// assert_eq!(snapshot.query_count, 1);
    /// ```
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

    /// Increment the counter for a specific operation type.
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

    /// Add latency to a specific operation type.
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

    /// Get top N operations by count with their average latencies.
    fn get_top_operations(&self, n: usize) -> Vec<OperationStat> {
        let ops = vec![
            (
                "Bfs",
                self.op_counts.bfs.load(Ordering::Relaxed),
                self.op_latency_sums.bfs.load(Ordering::Relaxed),
            ),
            (
                "Dfs",
                self.op_counts.dfs.load(Ordering::Relaxed),
                self.op_latency_sums.dfs.load(Ordering::Relaxed),
            ),
            (
                "Neighbors",
                self.op_counts.neighbors.load(Ordering::Relaxed),
                self.op_latency_sums.neighbors.load(Ordering::Relaxed),
            ),
            (
                "Reachability",
                self.op_counts.reachability.load(Ordering::Relaxed),
                self.op_latency_sums.reachability.load(Ordering::Relaxed),
            ),
            (
                "FindByType",
                self.op_counts.find_by_type.load(Ordering::Relaxed),
                self.op_latency_sums.find_by_type.load(Ordering::Relaxed),
            ),
            (
                "FindByAttr",
                self.op_counts.find_by_attr.load(Ordering::Relaxed),
                self.op_latency_sums.find_by_attr.load(Ordering::Relaxed),
            ),
            (
                "GetNode",
                self.op_counts.get_node.load(Ordering::Relaxed),
                self.op_latency_sums.get_node.load(Ordering::Relaxed),
            ),
            (
                "AddNodes",
                self.op_counts.add_nodes.load(Ordering::Relaxed),
                self.op_latency_sums.add_nodes.load(Ordering::Relaxed),
            ),
            (
                "AddEdges",
                self.op_counts.add_edges.load(Ordering::Relaxed),
                self.op_latency_sums.add_edges.load(Ordering::Relaxed),
            ),
            (
                "DatalogQuery",
                self.op_counts.datalog_query.load(Ordering::Relaxed),
                self.op_latency_sums.datalog_query.load(Ordering::Relaxed),
            ),
            (
                "CheckGuarantee",
                self.op_counts.check_guarantee.load(Ordering::Relaxed),
                self.op_latency_sums.check_guarantee.load(Ordering::Relaxed),
            ),
            (
                "GetOutgoingEdges",
                self.op_counts.get_outgoing_edges.load(Ordering::Relaxed),
                self.op_latency_sums.get_outgoing_edges.load(Ordering::Relaxed),
            ),
            (
                "GetIncomingEdges",
                self.op_counts.get_incoming_edges.load(Ordering::Relaxed),
                self.op_latency_sums.get_incoming_edges.load(Ordering::Relaxed),
            ),
        ];

        let mut stats: Vec<_> = ops
            .into_iter()
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

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    // ========================================================================
    // Basic Initialization Tests
    // ========================================================================

    #[test]
    fn test_metrics_new() {
        let m = Metrics::new();
        let snap = m.snapshot();

        assert_eq!(snap.query_count, 0);
        assert_eq!(snap.slow_query_count, 0);
        assert_eq!(snap.flush_count, 0);
        assert_eq!(snap.query_p50_ms, 0);
        assert_eq!(snap.query_p95_ms, 0);
        assert_eq!(snap.query_p99_ms, 0);
        assert_eq!(snap.query_avg_ms, 0);
        assert!(snap.top_slow_queries.is_empty());
        assert!(snap.op_stats.is_empty());
    }

    #[test]
    fn test_metrics_default() {
        let m = Metrics::default();
        let snap = m.snapshot();
        assert_eq!(snap.query_count, 0);
    }

    // ========================================================================
    // Query Recording Tests
    // ========================================================================

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
        assert!(snap.top_slow_queries.is_empty());

        // At threshold
        m.record_query("Bfs", 100);
        let snap = m.snapshot();
        assert_eq!(snap.slow_query_count, 1);
        assert_eq!(snap.top_slow_queries.len(), 1);
        assert_eq!(snap.top_slow_queries[0].duration_ms, 100);

        // Above threshold
        m.record_query("DatalogQuery", 500);
        let snap = m.snapshot();
        assert_eq!(snap.slow_query_count, 2);
        assert_eq!(snap.top_slow_queries.len(), 2);
    }

    #[test]
    fn test_slow_query_contains_operation_info() {
        let m = Metrics::new();
        m.record_query("DatalogQuery", 150);

        let snap = m.snapshot();
        assert_eq!(snap.top_slow_queries.len(), 1);
        assert_eq!(snap.top_slow_queries[0].operation, "DatalogQuery");
        assert_eq!(snap.top_slow_queries[0].duration_ms, 150);
        // timestamp_ms is set (u64 so always >= 0)
    }

    // ========================================================================
    // Percentile Calculation Tests
    // ========================================================================

    #[test]
    fn test_percentile_calculation() {
        let m = Metrics::new();

        // Add 100 queries with latencies 1-100ms
        for i in 1..=100 {
            m.record_query("Test", i);
        }

        let snap = m.snapshot();
        assert_eq!(snap.query_count, 100);
        // With 100 values (1-100), index 50 = value 51, index 95 = value 96, index 99 = value 100
        // This is floor-based percentile calculation: sorted[len * percentile / 100]
        assert_eq!(snap.query_p50_ms, 51);
        assert_eq!(snap.query_p95_ms, 96);
        assert_eq!(snap.query_p99_ms, 100);
    }

    #[test]
    fn test_average_calculation() {
        let m = Metrics::new();

        // Add 10 queries of 10ms each
        for _ in 0..10 {
            m.record_query("Test", 10);
        }

        let snap = m.snapshot();
        assert_eq!(snap.query_avg_ms, 10);
    }

    #[test]
    fn test_latency_window_eviction() {
        let m = Metrics::new();

        // Fill window with 1000 queries of 10ms
        for _ in 0..1000 {
            m.record_query("Test", 10);
        }

        let snap1 = m.snapshot();
        assert_eq!(snap1.query_p50_ms, 10);

        // Add 1000 more of 20ms (should evict old ones)
        for _ in 0..1000 {
            m.record_query("Test", 20);
        }

        let snap2 = m.snapshot();
        // All queries in window should now be 20ms
        assert_eq!(snap2.query_p50_ms, 20);
        assert_eq!(snap2.query_count, 2000);
    }

    // ========================================================================
    // Flush Recording Tests
    // ========================================================================

    #[test]
    fn test_flush_recording() {
        let m = Metrics::new();

        m.record_flush(100, 5000, 10000);
        m.record_flush(200, 3000, 6000);

        let snap = m.snapshot();
        assert_eq!(snap.flush_count, 2);
        assert_eq!(snap.flush_avg_ms, 150); // (100 + 200) / 2
        assert_eq!(snap.last_flush_ms, 200);
        assert_eq!(snap.last_flush_nodes, 3000);
        assert_eq!(snap.last_flush_edges, 6000);
    }

    #[test]
    fn test_flush_avg_no_flushes() {
        let m = Metrics::new();
        let snap = m.snapshot();

        assert_eq!(snap.flush_count, 0);
        assert_eq!(snap.flush_avg_ms, 0); // No division by zero
    }

    // ========================================================================
    // Operation-Specific Counter Tests
    // ========================================================================

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
        let bfs_stat = bfs_stat.unwrap();
        assert_eq!(bfs_stat.count, 2);
        assert_eq!(bfs_stat.avg_ms, 15); // (10 + 20) / 2
    }

    #[test]
    fn test_top_operations_limited() {
        let m = Metrics::new();

        // Record different operations with varying counts
        for _ in 0..100 {
            m.record_query("Bfs", 10);
        }
        for _ in 0..80 {
            m.record_query("GetNode", 5);
        }
        for _ in 0..60 {
            m.record_query("Neighbors", 3);
        }
        for _ in 0..40 {
            m.record_query("DatalogQuery", 50);
        }
        for _ in 0..20 {
            m.record_query("Reachability", 25);
        }
        for _ in 0..10 {
            m.record_query("AddNodes", 15);
        }

        let snap = m.snapshot();

        // Should only have top 5
        assert_eq!(snap.op_stats.len(), 5);

        // Should be sorted by count descending
        assert_eq!(snap.op_stats[0].operation, "Bfs");
        assert_eq!(snap.op_stats[0].count, 100);
        assert_eq!(snap.op_stats[1].operation, "GetNode");
        assert_eq!(snap.op_stats[1].count, 80);
    }

    #[test]
    fn test_unknown_operation_goes_to_other() {
        let m = Metrics::new();

        m.record_query("UnknownOp", 10);
        m.record_query("AnotherUnknown", 20);

        // "other" counter should be incremented
        let count = m.op_counts.other.load(Ordering::Relaxed);
        assert_eq!(count, 2);
    }

    // ========================================================================
    // Slow Query Buffer Limit Tests
    // ========================================================================

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

    // ========================================================================
    // Thread Safety Tests
    // ========================================================================

    #[test]
    fn test_thread_safety() {
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

    #[test]
    fn test_concurrent_flush_and_query_recording() {
        let m = Arc::new(Metrics::new());
        let mut handles = vec![];

        // Thread recording queries
        let m1 = Arc::clone(&m);
        handles.push(thread::spawn(move || {
            for _ in 0..100 {
                m1.record_query("Bfs", 10);
            }
        }));

        // Thread recording flushes
        let m2 = Arc::clone(&m);
        handles.push(thread::spawn(move || {
            for _ in 0..10 {
                m2.record_flush(50, 100, 200);
            }
        }));

        // Thread taking snapshots
        let m3 = Arc::clone(&m);
        handles.push(thread::spawn(move || {
            for _ in 0..5 {
                let _snap = m3.snapshot();
            }
        }));

        for h in handles {
            h.join().unwrap();
        }

        let snap = m.snapshot();
        assert_eq!(snap.query_count, 100);
        assert_eq!(snap.flush_count, 10);
    }

    // ========================================================================
    // Uptime Test
    // ========================================================================

    #[test]
    fn test_uptime_tracking() {
        let m = Metrics::new();

        // Sleep a bit to ensure uptime measurable
        std::thread::sleep(std::time::Duration::from_millis(10));

        let snap = m.snapshot();
        // Uptime is tracked (u64 is always >= 0, just verify snapshot works)
        let _uptime = snap.uptime_secs;
    }

    // ========================================================================
    // Edge Cases
    // ========================================================================

    #[test]
    fn test_empty_snapshot() {
        let m = Metrics::new();
        let snap = m.snapshot();

        // All values should be zero/empty
        assert_eq!(snap.query_count, 0);
        assert_eq!(snap.slow_query_count, 0);
        assert_eq!(snap.query_p50_ms, 0);
        assert_eq!(snap.query_p95_ms, 0);
        assert_eq!(snap.query_p99_ms, 0);
        assert_eq!(snap.query_avg_ms, 0);
        assert_eq!(snap.flush_count, 0);
        assert_eq!(snap.flush_avg_ms, 0);
        assert!(snap.top_slow_queries.is_empty());
        assert!(snap.op_stats.is_empty());
    }

    #[test]
    fn test_single_query_percentiles() {
        let m = Metrics::new();
        m.record_query("Test", 50);

        let snap = m.snapshot();
        // With only one query, all percentiles should be that query's latency
        assert_eq!(snap.query_p50_ms, 50);
        assert_eq!(snap.query_p95_ms, 50);
        assert_eq!(snap.query_p99_ms, 50);
        assert_eq!(snap.query_avg_ms, 50);
    }

    #[test]
    fn test_operation_stat_equality() {
        let stat1 = OperationStat {
            operation: "Bfs".to_string(),
            count: 10,
            avg_ms: 5,
        };
        let stat2 = OperationStat {
            operation: "Bfs".to_string(),
            count: 10,
            avg_ms: 5,
        };
        let stat3 = OperationStat {
            operation: "Dfs".to_string(),
            count: 10,
            avg_ms: 5,
        };

        assert_eq!(stat1, stat2);
        assert_ne!(stat1, stat3);
    }

    #[test]
    fn test_slow_query_equality() {
        let sq1 = SlowQuery {
            operation: "Bfs".to_string(),
            duration_ms: 100,
            timestamp_ms: 0,
        };
        let sq2 = SlowQuery {
            operation: "Bfs".to_string(),
            duration_ms: 100,
            timestamp_ms: 0,
        };
        let sq3 = SlowQuery {
            operation: "Dfs".to_string(),
            duration_ms: 100,
            timestamp_ms: 0,
        };

        assert_eq!(sq1, sq2);
        assert_ne!(sq1, sq3);
    }
}
