//! System resource detection and adaptive tuning for RFDB.
//!
//! Detects available RAM and CPU cores, then computes tuning parameters
//! that adapt RFDB behavior to the host machine. Stateless: each call
//! to `ResourceManager::auto_tune()` re-probes the system.

use sysinfo::{MemoryRefreshKind, RefreshKind, System};

// ── Constants ───────────────────────────────────────────────────────

const MB: usize = 1024 * 1024;
const GB: u64 = 1024 * 1024 * 1024;

/// Estimated bytes per node record (used to derive node-count limits).
const BYTES_PER_NODE: usize = 220;

/// Write buffer floor (10 MB).
const WRITE_BUFFER_MIN: usize = 10 * MB;

/// Write buffer ceiling (100 MB).
const WRITE_BUFFER_MAX: usize = 100 * MB;

/// Fraction of available memory allocated to the write buffer.
const WRITE_BUFFER_FRACTION: f64 = 0.02;

// ── SystemResources ─────────────────────────────────────────────────

/// Snapshot of detected hardware resources.
#[derive(Debug, Clone)]
pub struct SystemResources {
    /// Total physical RAM in bytes.
    pub total_memory_bytes: u64,
    /// Available (re-usable) RAM in bytes.
    pub available_memory_bytes: u64,
    /// Logical CPU count.
    pub cpu_count: usize,
}

impl SystemResources {
    /// Probe the current system for RAM and CPU information.
    pub fn detect() -> Self {
        let mut sys = System::new_with_specifics(
            RefreshKind::new().with_memory(MemoryRefreshKind::everything()),
        );
        sys.refresh_memory();

        let cpu_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);

        Self {
            total_memory_bytes: sys.total_memory(),
            available_memory_bytes: sys.available_memory(),
            cpu_count,
        }
    }

    /// Memory pressure indicator (0.0 = no pressure, 1.0 = critical).
    ///
    /// Formula: `1.0 - (available / total)`.
    pub fn memory_pressure(&self) -> f64 {
        if self.total_memory_bytes == 0 {
            return 1.0;
        }
        let ratio = self.available_memory_bytes as f64 / self.total_memory_bytes as f64;
        (1.0 - ratio).clamp(0.0, 1.0)
    }
}

// ── TuningProfile ───────────────────────────────────────────────────

/// Adaptive parameters computed from system resources.
#[derive(Debug, Clone)]
pub struct TuningProfile {
    /// Number of shards for the multi-shard store.
    pub shard_count: u16,
    /// L0 segment count threshold before compaction triggers.
    pub segment_threshold: usize,
    /// Max node records in the write buffer before auto-flush.
    pub write_buffer_node_limit: usize,
    /// Max bytes in the write buffer before auto-flush.
    pub write_buffer_byte_limit: usize,
    /// Number of threads for parallel compaction.
    pub compaction_threads: usize,
    /// Memory pressure at detection time (0.0 = no pressure, 1.0 = critical).
    pub memory_pressure: f64,
}

impl TuningProfile {
    /// Compute a tuning profile from detected resources.
    ///
    /// Heuristics:
    /// - `shard_count`: `min(16, next_power_of_two(cpu_count))` if RAM >= 2 GB, else 1.
    /// - `segment_threshold`: RAM < 4 GB -> 2, < 16 GB -> 4, else 8.
    /// - `write_buffer_byte_limit`: `clamp(available * 0.02, 10 MB, 100 MB)`.
    /// - `write_buffer_node_limit`: `buffer_bytes / 220`.
    /// - `compaction_threads`: RAM < 4 GB -> 1, else `clamp(cpu / 2, 1, 4)`.
    pub fn from_resources(res: &SystemResources) -> Self {
        let total_gb = res.total_memory_bytes as f64 / GB as f64;

        // Shard count
        let shard_count = if res.total_memory_bytes >= 2 * GB {
            let raw = res.cpu_count.next_power_of_two();
            raw.min(16) as u16
        } else {
            1
        };

        // Segment threshold
        let segment_threshold = if total_gb < 4.0 {
            2
        } else if total_gb < 16.0 {
            4
        } else {
            8
        };

        // Write buffer byte limit
        let raw_bytes = (res.available_memory_bytes as f64 * WRITE_BUFFER_FRACTION) as usize;
        let write_buffer_byte_limit = raw_bytes.clamp(WRITE_BUFFER_MIN, WRITE_BUFFER_MAX);

        // Write buffer node limit
        let write_buffer_node_limit = write_buffer_byte_limit / BYTES_PER_NODE;

        // Compaction threads
        let compaction_threads = if total_gb < 4.0 {
            1
        } else {
            (res.cpu_count / 2).clamp(1, 4)
        };

        Self {
            shard_count,
            segment_threshold,
            write_buffer_node_limit,
            write_buffer_byte_limit,
            compaction_threads,
            memory_pressure: res.memory_pressure(),
        }
    }
}

impl Default for TuningProfile {
    /// Conservative defaults suitable for tests and unknown environments.
    fn default() -> Self {
        Self {
            shard_count: 4,
            segment_threshold: 4,
            write_buffer_node_limit: 50_000,
            write_buffer_byte_limit: 10 * MB,
            compaction_threads: 1,
            memory_pressure: 0.0,
        }
    }
}

// ── ResourceManager ─────────────────────────────────────────────────

/// Stateless utility: detect system resources and compute tuning profile.
pub struct ResourceManager;

impl ResourceManager {
    /// Probe the system and return an adaptive tuning profile.
    pub fn auto_tune() -> TuningProfile {
        let resources = SystemResources::detect();
        TuningProfile::from_resources(&resources)
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: build `SystemResources` with explicit values (bypasses detection).
    fn make_resources(total_gb: f64, available_gb: f64, cpus: usize) -> SystemResources {
        SystemResources {
            total_memory_bytes: (total_gb * GB as f64) as u64,
            available_memory_bytes: (available_gb * GB as f64) as u64,
            cpu_count: cpus,
        }
    }

    #[test]
    fn test_system_resources_detection() {
        let res = SystemResources::detect();
        assert!(res.total_memory_bytes > 0, "total memory must be positive");
        assert!(res.cpu_count >= 1, "cpu count must be at least 1");
    }

    #[test]
    fn test_tuning_profile_low_memory() {
        // 1 GB RAM, 4 CPUs -> shard=1, threshold=2, threads=1
        let res = make_resources(1.0, 0.5, 4);
        let profile = TuningProfile::from_resources(&res);

        assert_eq!(profile.shard_count, 1);
        assert_eq!(profile.segment_threshold, 2);
        assert_eq!(profile.compaction_threads, 1);
    }

    #[test]
    fn test_tuning_profile_medium_memory() {
        // 8 GB RAM, 4 CPUs -> shard=4, threshold=4, threads=2
        let res = make_resources(8.0, 4.0, 4);
        let profile = TuningProfile::from_resources(&res);

        assert_eq!(profile.shard_count, 4);
        assert_eq!(profile.segment_threshold, 4);
        assert_eq!(profile.compaction_threads, 2);
    }

    #[test]
    fn test_tuning_profile_high_memory() {
        // 64 GB RAM, 16 CPUs -> shard=16, threshold=8, threads=4 (capped)
        let res = make_resources(64.0, 32.0, 16);
        let profile = TuningProfile::from_resources(&res);

        assert_eq!(profile.shard_count, 16);
        assert_eq!(profile.segment_threshold, 8);
        assert_eq!(profile.compaction_threads, 4);
    }

    #[test]
    fn test_write_buffer_limits_bounded() {
        // 512 GB total, lots of available -> buffer capped at 100 MB
        let res = make_resources(512.0, 256.0, 32);
        let profile = TuningProfile::from_resources(&res);

        assert_eq!(profile.write_buffer_byte_limit, 100 * MB);
        assert_eq!(profile.write_buffer_node_limit, 100 * MB / 220);
    }

    #[test]
    fn test_write_buffer_limits_minimum() {
        // 256 MB available -> 2% is ~5 MB, floored at 10 MB
        let res = make_resources(1.0, 0.25, 2);
        let profile = TuningProfile::from_resources(&res);

        assert_eq!(profile.write_buffer_byte_limit, 10 * MB);
        assert_eq!(profile.write_buffer_node_limit, 10 * MB / 220);
    }

    #[test]
    fn test_tuning_profile_default() {
        let profile = TuningProfile::default();

        assert_eq!(profile.shard_count, 4);
        assert_eq!(profile.segment_threshold, 4);
        assert_eq!(profile.write_buffer_node_limit, 50_000);
        assert_eq!(profile.write_buffer_byte_limit, 10 * MB);
        assert_eq!(profile.compaction_threads, 1);
    }

    #[test]
    fn test_memory_pressure() {
        // 1 GB total, 256 MB available -> pressure = 0.75
        let res = make_resources(1.0, 0.25, 2);
        let pressure = res.memory_pressure();

        let expected = 0.75;
        assert!(
            (pressure - expected).abs() < 1e-9,
            "expected pressure ~{expected}, got {pressure}"
        );
    }
}
