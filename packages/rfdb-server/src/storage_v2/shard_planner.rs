//! Deterministic shard assignment for RFDB v2 multi-shard storage.
//!
//! Maps file paths to shard IDs using directory-based blake3 hashing.
//! Files in the same directory always land in the same shard, which
//! provides locality for common query patterns (e.g., "find all nodes
//! in src/utils/").
//!
//! The hash is computed on the parent directory of the file path,
//! then reduced to `[0, shard_count)` via modulo.

use std::collections::HashMap;
use std::path::Path;

/// Deterministic shard planner: file path -> shard_id.
///
/// Assigns files to shards based on their parent directory.
/// Same directory = same shard (locality optimization).
pub struct ShardPlanner {
    shard_count: u16,
}

impl ShardPlanner {
    /// Create a planner for the given number of shards.
    ///
    /// # Panics
    ///
    /// Panics if `shard_count` is 0.
    pub fn new(shard_count: u16) -> Self {
        assert!(shard_count > 0, "shard_count must be > 0");
        Self { shard_count }
    }

    /// Number of shards this planner distributes across.
    pub fn shard_count(&self) -> u16 {
        self.shard_count
    }

    /// Compute shard ID for a file path.
    ///
    /// Uses blake3 hash of the parent directory, reduced via modulo.
    /// Files without a parent directory (e.g., "file.js") hash the
    /// empty string, so they all land in the same shard.
    pub fn compute_shard_id(&self, file_path: &str) -> u16 {
        let dir = Path::new(file_path)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        let hash = blake3::hash(dir.as_bytes());
        let hash_u64 = u64::from_le_bytes(hash.as_bytes()[0..8].try_into().unwrap());
        (hash_u64 % self.shard_count as u64) as u16
    }

    /// Plan shard assignment for a batch of file paths.
    ///
    /// Returns a map: shard_id -> list of file paths assigned to that shard.
    /// Every input file appears in exactly one shard's list.
    pub fn plan(&self, files: &[&str]) -> HashMap<u16, Vec<String>> {
        let mut result: HashMap<u16, Vec<String>> = HashMap::new();
        for file in files {
            let shard_id = self.compute_shard_id(file);
            result.entry(shard_id).or_default().push(file.to_string());
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn test_compute_shard_id_deterministic() {
        let planner = ShardPlanner::new(8);
        let path = "src/utils/helper.js";

        let id1 = planner.compute_shard_id(path);
        let id2 = planner.compute_shard_id(path);
        let id3 = planner.compute_shard_id(path);

        assert_eq!(id1, id2);
        assert_eq!(id2, id3);
        assert!(id1 < 8);
    }

    #[test]
    fn test_same_directory_same_shard() {
        let planner = ShardPlanner::new(16);

        let a = planner.compute_shard_id("src/utils/a.js");
        let b = planner.compute_shard_id("src/utils/b.js");
        let c = planner.compute_shard_id("src/utils/c.ts");

        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn test_different_directories_likely_different_shards() {
        // With enough shards, different directories should (usually)
        // map to different shards. We test with many directories to
        // ensure at least 2 distinct shards appear.
        let planner = ShardPlanner::new(64);

        let dirs = [
            "src/a.js",
            "lib/b.js",
            "test/c.js",
            "vendor/d.js",
            "build/e.js",
            "config/f.js",
        ];

        let shard_ids: HashSet<u16> = dirs
            .iter()
            .map(|f| planner.compute_shard_id(f))
            .collect();

        // With 6 different directories and 64 shards, extremely unlikely
        // they all hash to the same shard.
        assert!(
            shard_ids.len() >= 2,
            "Expected at least 2 distinct shards, got {}: {:?}",
            shard_ids.len(),
            shard_ids,
        );
    }

    #[test]
    fn test_plan_groups_files_correctly() {
        let planner = ShardPlanner::new(4);

        let files = &[
            "src/utils/a.js",
            "src/utils/b.js",
            "lib/core/c.js",
            "lib/core/d.js",
        ];
        let plan = planner.plan(files);

        // Files in same directory must be in same shard
        let shard_a = planner.compute_shard_id("src/utils/a.js");
        let shard_c = planner.compute_shard_id("lib/core/c.js");

        let group_a = &plan[&shard_a];
        assert!(group_a.contains(&"src/utils/a.js".to_string()));
        assert!(group_a.contains(&"src/utils/b.js".to_string()));

        let group_c = &plan[&shard_c];
        assert!(group_c.contains(&"lib/core/c.js".to_string()));
        assert!(group_c.contains(&"lib/core/d.js".to_string()));
    }

    #[test]
    fn test_plan_all_files_assigned() {
        let planner = ShardPlanner::new(8);
        let files: Vec<&str> = (0..50)
            .map(|i| {
                // Leak strings for test lifetime — acceptable in tests
                let s: &str = Box::leak(format!("dir_{}/file_{}.js", i % 7, i).into_boxed_str());
                s
            })
            .collect();

        let plan = planner.plan(&files);

        // Every file must appear exactly once across all shards
        let total: usize = plan.values().map(|v| v.len()).sum();
        assert_eq!(total, 50);

        // All shard IDs must be in range
        for shard_id in plan.keys() {
            assert!(*shard_id < 8);
        }
    }

    #[test]
    fn test_single_shard_all_same() {
        let planner = ShardPlanner::new(1);
        assert_eq!(planner.compute_shard_id("a/b.js"), 0);
        assert_eq!(planner.compute_shard_id("c/d.js"), 0);
        assert_eq!(planner.compute_shard_id("e.js"), 0);
    }

    #[test]
    fn test_root_files_same_shard() {
        // Files with no parent directory should all hash to the same shard
        let planner = ShardPlanner::new(8);
        let a = planner.compute_shard_id("file_a.js");
        let b = planner.compute_shard_id("file_b.js");
        assert_eq!(a, b);
    }

    #[test]
    #[should_panic(expected = "shard_count must be > 0")]
    fn test_zero_shards_panics() {
        ShardPlanner::new(0);
    }
}
