//! Generation-based garbage collection.
//!
//! Provides generation stamping for traceability (which analysis run created which data)
//! and incremental analysis support via mtime-based change detection and deleted file cleanup.
//!
//! The orchestrator uses RFDB's `CommitBatch` which atomically replaces all nodes/edges
//! for changed files — so per-file GC is handled by CommitBatch semantics. This module
//! adds the generation tracking layer on top: stamping metadata, filtering unchanged files,
//! and detecting deleted files.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Statistics from a GC run.
#[derive(Debug, Default)]
pub struct GcStats {
    pub nodes_removed: usize,
    pub edges_removed: usize,
    pub files_analyzed: usize,
    pub files_skipped: usize,
    pub files_deleted: usize,
    pub generation: u64,
}

/// Tracks the current generation counter and per-file modification times
/// for incremental analysis.
///
/// Each analysis run bumps the generation, and all produced nodes/edges
/// are stamped with that generation number for traceability.
///
/// REG-1197: the tracker also records whether the run that wrote it finished.
/// A stored mtime only means "this file is represented in the graph" if the run
/// that stored it survived every phase — otherwise the graph is partial and the
/// mtimes must not be read as "up to date".
pub struct GenerationTracker {
    current: u64,
    file_mtimes: HashMap<PathBuf, SystemTime>,
    last_run_complete: bool,
}

/// Serializable representation of tracker state for disk persistence.
#[derive(Serialize, Deserialize)]
struct TrackerState {
    generation: u64,
    file_mtimes: HashMap<String, u64>,
    /// Whether the run that wrote this file reached the end of its pipeline
    /// (REG-1197). Absent in files written before this field existed — and
    /// those are exactly the trackers a masked failure could have poisoned, so
    /// the missing value defaults to `false` (untrusted) rather than `true`.
    #[serde(default)]
    complete: bool,
}

impl GenerationTracker {
    /// Create a new tracker with the given initial generation.
    ///
    /// A tracker with no stored mtimes cannot mislead anyone into skipping work,
    /// so it starts out trusted.
    pub fn new(generation: u64) -> Self {
        Self {
            current: generation,
            file_mtimes: HashMap::new(),
            last_run_complete: true,
        }
    }

    /// Load tracker state from disk. Returns default (empty) if file doesn't exist or is invalid.
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<TrackerState>(&content) {
                Ok(state) => {
                    let file_mtimes = state
                        .file_mtimes
                        .into_iter()
                        .map(|(k, v)| {
                            let mtime = UNIX_EPOCH + Duration::from_nanos(v);
                            (PathBuf::from(k), mtime)
                        })
                        .collect();
                    Self {
                        current: state.generation,
                        file_mtimes,
                        last_run_complete: state.complete,
                    }
                }
                Err(_) => Self::new(0),
            },
            Err(_) => Self::new(0),
        }
    }

    /// Save tracker state to disk, recording whether the run that is writing it
    /// has finished.
    ///
    /// `complete` is a parameter rather than an internal flag on purpose: the
    /// defect this replaces (REG-1197) was a `save()` in the middle of the
    /// pipeline that implicitly meant "done". Every call site now has to say
    /// which it means.
    pub fn save_with_status(&self, path: &Path, complete: bool) -> Result<()> {
        let state = TrackerState {
            generation: self.current,
            file_mtimes: self
                .file_mtimes
                .iter()
                .map(|(k, v)| {
                    let secs = v.duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
                    (k.display().to_string(), secs)
                })
                .collect(),
            complete,
        };
        let json = serde_json::to_string_pretty(&state)?;
        fs::write(path, json)?;
        Ok(())
    }

    /// Whether the run that last wrote this tracker reached the end of its
    /// pipeline. `false` means the stored mtimes describe a graph that was
    /// never finished — see [`GenerationTracker`].
    pub fn last_run_complete(&self) -> bool {
        self.last_run_complete
    }

    /// Increment the generation counter and return the new value.
    pub fn bump(&mut self) -> u64 {
        self.current += 1;
        self.current
    }

    /// Return the current generation number.
    pub fn current(&self) -> u64 {
        self.current
    }
}

/// Stamp `_generation` and `_source` into node metadata.
///
/// If `metadata` is `None`, creates a new JSON object with the two fields.
/// If `Some`, parses the existing JSON, merges the fields in, and re-serializes.
pub fn stamp_node_metadata(metadata: &mut Option<String>, generation: u64, source: &str) {
    stamp_metadata(metadata, generation, source);
}

/// Stamp `_generation` and `_source` into edge metadata.
///
/// Behaves identically to [`stamp_node_metadata`] — separate function
/// for clarity at call sites and future divergence.
pub fn stamp_edge_metadata(metadata: &mut Option<String>, generation: u64, source: &str) {
    stamp_metadata(metadata, generation, source);
}

/// Shared implementation for metadata stamping.
fn stamp_metadata(metadata: &mut Option<String>, generation: u64, source: &str) {
    let mut obj = match metadata {
        Some(existing) => serde_json::from_str::<serde_json::Value>(existing)
            .unwrap_or_else(|_| serde_json::json!({})),
        None => serde_json::json!({}),
    };

    if let Some(map) = obj.as_object_mut() {
        map.insert(
            "_generation".to_string(),
            serde_json::Value::Number(generation.into()),
        );
        map.insert(
            "_source".to_string(),
            serde_json::Value::String(source.to_string()),
        );
    }

    *metadata = Some(serde_json::to_string(&obj).expect("JSON serialization should not fail"));
}

/// Partition files into changed and unchanged based on stored mtimes.
///
/// Returns `(changed_files, unchanged_files)`.
///
/// - If `force` is true, all files are considered changed.
/// - Otherwise, a file is "changed" if it is new (not in the tracker)
///   or its current mtime differs from the stored mtime.
pub fn filter_changed_files(
    files: &[PathBuf],
    tracker: &GenerationTracker,
    force: bool,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
    if force {
        return Ok((files.to_vec(), Vec::new()));
    }

    let mut changed = Vec::new();
    let mut unchanged = Vec::new();

    for file in files {
        let current_mtime = fs::metadata(file)
            .and_then(|m| m.modified())
            .with_context(|| format!("Failed to read mtime for {}", file.display()))?;

        match tracker.file_mtimes.get(file) {
            Some(stored_mtime) if *stored_mtime == current_mtime => {
                unchanged.push(file.clone());
            }
            _ => {
                changed.push(file.clone());
            }
        }
    }

    Ok((changed, unchanged))
}

/// Update stored mtimes in the tracker after successful analysis.
///
/// Reads each file's current mtime from the filesystem and stores it.
pub fn update_mtimes(tracker: &mut GenerationTracker, files: &[PathBuf]) -> Result<()> {
    for file in files {
        let mtime = fs::metadata(file)
            .and_then(|m| m.modified())
            .with_context(|| format!("Failed to read mtime for {}", file.display()))?;
        tracker.file_mtimes.insert(file.clone(), mtime);
    }
    Ok(())
}

/// Detect files that were previously tracked but are no longer present in discovery.
///
/// Returns the list of paths that exist in the tracker but not in `current_files`.
/// These represent deleted files whose graph data should be cleaned up.
pub fn detect_deleted_files(
    tracker: &GenerationTracker,
    current_files: &[PathBuf],
) -> Vec<PathBuf> {
    let current_set: std::collections::HashSet<&PathBuf> = current_files.iter().collect();

    tracker
        .file_mtimes
        .keys()
        .filter(|tracked| !current_set.contains(tracked))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Create a unique temp directory with the given files.
    fn create_test_tree(files: &[&str]) -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join("grafema-gc-tests")
            .join(format!("{}_{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        for file in files {
            let path = dir.join(file);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, "// test content").unwrap();
        }
        dir
    }

    fn cleanup(dir: &std::path::Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn generation_starts_at_initial_value() {
        let tracker = GenerationTracker::new(0);
        assert_eq!(tracker.current(), 0);
    }

    #[test]
    fn generation_bumps_correctly() {
        let mut tracker = GenerationTracker::new(0);
        assert_eq!(tracker.bump(), 1);
        assert_eq!(tracker.bump(), 2);
        assert_eq!(tracker.current(), 2);
    }

    #[test]
    fn generation_starts_at_nonzero() {
        let mut tracker = GenerationTracker::new(41);
        assert_eq!(tracker.bump(), 42);
        assert_eq!(tracker.current(), 42);
    }

    #[test]
    fn stamp_node_metadata_on_none() {
        let mut meta: Option<String> = None;
        stamp_node_metadata(&mut meta, 5, "analyzer-v1");

        let parsed: serde_json::Value = serde_json::from_str(meta.as_ref().unwrap()).unwrap();
        assert_eq!(parsed["_generation"], 5);
        assert_eq!(parsed["_source"], "analyzer-v1");
    }

    #[test]
    fn stamp_node_metadata_on_existing() {
        let mut meta = Some(r#"{"kind":"function","lines":42}"#.to_string());
        stamp_node_metadata(&mut meta, 3, "parser");

        let parsed: serde_json::Value = serde_json::from_str(meta.as_ref().unwrap()).unwrap();
        assert_eq!(parsed["_generation"], 3);
        assert_eq!(parsed["_source"], "parser");
        // Original fields preserved
        assert_eq!(parsed["kind"], "function");
        assert_eq!(parsed["lines"], 42);
    }

    #[test]
    fn stamp_node_metadata_overwrites_existing_generation() {
        let mut meta = Some(r#"{"_generation":1,"_source":"old"}"#.to_string());
        stamp_node_metadata(&mut meta, 99, "new-source");

        let parsed: serde_json::Value = serde_json::from_str(meta.as_ref().unwrap()).unwrap();
        assert_eq!(parsed["_generation"], 99);
        assert_eq!(parsed["_source"], "new-source");
    }

    #[test]
    fn stamp_edge_metadata_works() {
        let mut meta: Option<String> = None;
        stamp_edge_metadata(&mut meta, 7, "edge-source");

        let parsed: serde_json::Value = serde_json::from_str(meta.as_ref().unwrap()).unwrap();
        assert_eq!(parsed["_generation"], 7);
        assert_eq!(parsed["_source"], "edge-source");
    }

    #[test]
    fn stamp_metadata_handles_invalid_json() {
        let mut meta = Some("not valid json {{{".to_string());
        stamp_node_metadata(&mut meta, 1, "recovery");

        let parsed: serde_json::Value = serde_json::from_str(meta.as_ref().unwrap()).unwrap();
        assert_eq!(parsed["_generation"], 1);
        assert_eq!(parsed["_source"], "recovery");
    }

    #[test]
    fn filter_changed_files_force_returns_all() {
        let dir = create_test_tree(&["a.js", "b.js"]);
        let files: Vec<PathBuf> = vec![dir.join("a.js"), dir.join("b.js")];
        let tracker = GenerationTracker::new(0);

        let (changed, unchanged) = filter_changed_files(&files, &tracker, true).unwrap();
        assert_eq!(changed.len(), 2);
        assert!(unchanged.is_empty());
        cleanup(&dir);
    }

    #[test]
    fn filter_changed_files_new_files_are_changed() {
        let dir = create_test_tree(&["a.js", "b.js"]);
        let files: Vec<PathBuf> = vec![dir.join("a.js"), dir.join("b.js")];
        let tracker = GenerationTracker::new(0);

        let (changed, unchanged) = filter_changed_files(&files, &tracker, false).unwrap();
        assert_eq!(changed.len(), 2, "New files should be 'changed'");
        assert!(unchanged.is_empty());
        cleanup(&dir);
    }

    #[test]
    fn filter_changed_files_unchanged_after_mtime_update() {
        let dir = create_test_tree(&["a.js", "b.js"]);
        let files: Vec<PathBuf> = vec![dir.join("a.js"), dir.join("b.js")];
        let mut tracker = GenerationTracker::new(0);

        update_mtimes(&mut tracker, &files).unwrap();

        let (changed, unchanged) = filter_changed_files(&files, &tracker, false).unwrap();
        assert!(changed.is_empty(), "Files should be unchanged after mtime update");
        assert_eq!(unchanged.len(), 2);
        cleanup(&dir);
    }

    #[test]
    fn filter_changed_files_detects_modification() {
        let dir = create_test_tree(&["a.js"]);
        let files: Vec<PathBuf> = vec![dir.join("a.js")];
        let mut tracker = GenerationTracker::new(0);

        update_mtimes(&mut tracker, &files).unwrap();

        // Ensure mtime changes — sleep briefly then rewrite
        thread::sleep(Duration::from_millis(50));
        fs::write(&files[0], "// modified content").unwrap();

        let (changed, unchanged) = filter_changed_files(&files, &tracker, false).unwrap();
        assert_eq!(changed.len(), 1, "Modified file should be 'changed'");
        assert!(unchanged.is_empty());
        cleanup(&dir);
    }

    #[test]
    fn detect_deleted_files_none_deleted() {
        let mut tracker = GenerationTracker::new(0);
        let a = PathBuf::from("/project/a.js");
        let b = PathBuf::from("/project/b.js");
        tracker
            .file_mtimes
            .insert(a.clone(), SystemTime::UNIX_EPOCH);
        tracker
            .file_mtimes
            .insert(b.clone(), SystemTime::UNIX_EPOCH);

        let current = vec![a, b];
        let deleted = detect_deleted_files(&tracker, &current);
        assert!(deleted.is_empty());
    }

    #[test]
    fn detect_deleted_files_some_deleted() {
        let mut tracker = GenerationTracker::new(0);
        let a = PathBuf::from("/project/a.js");
        let b = PathBuf::from("/project/b.js");
        let c = PathBuf::from("/project/c.js");
        tracker
            .file_mtimes
            .insert(a.clone(), SystemTime::UNIX_EPOCH);
        tracker
            .file_mtimes
            .insert(b.clone(), SystemTime::UNIX_EPOCH);
        tracker
            .file_mtimes
            .insert(c.clone(), SystemTime::UNIX_EPOCH);

        // Only a.js remains
        let current = vec![a];
        let mut deleted = detect_deleted_files(&tracker, &current);
        deleted.sort();
        assert_eq!(deleted, vec![b, c]);
    }

    #[test]
    fn detect_deleted_files_empty_tracker() {
        let tracker = GenerationTracker::new(0);
        let current = vec![PathBuf::from("/project/a.js")];
        let deleted = detect_deleted_files(&tracker, &current);
        assert!(deleted.is_empty());
    }

    #[test]
    fn detect_deleted_files_all_deleted() {
        let mut tracker = GenerationTracker::new(0);
        let a = PathBuf::from("/project/a.js");
        tracker
            .file_mtimes
            .insert(a.clone(), SystemTime::UNIX_EPOCH);

        let current: Vec<PathBuf> = vec![];
        let deleted = detect_deleted_files(&tracker, &current);
        assert_eq!(deleted, vec![a]);
    }

    #[test]
    fn update_mtimes_stores_values() {
        let dir = create_test_tree(&["x.js"]);
        let files = vec![dir.join("x.js")];
        let mut tracker = GenerationTracker::new(0);

        assert!(tracker.file_mtimes.is_empty());
        update_mtimes(&mut tracker, &files).unwrap();
        assert_eq!(tracker.file_mtimes.len(), 1);
        assert!(tracker.file_mtimes.contains_key(&files[0]));
        cleanup(&dir);
    }

    #[test]
    fn gc_stats_default() {
        let stats = GcStats::default();
        assert_eq!(stats.nodes_removed, 0);
        assert_eq!(stats.edges_removed, 0);
        assert_eq!(stats.files_analyzed, 0);
        assert_eq!(stats.files_skipped, 0);
        assert_eq!(stats.files_deleted, 0);
        assert_eq!(stats.generation, 0);
    }

    // -- REG-1197: completion status survives the round trip --

    /// The status a run writes is the status the next run reads. Without this
    /// the whole mechanism is decorative.
    #[test]
    fn completion_status_round_trips() {
        let dir = create_test_tree(&["a.js"]);
        let path = dir.join("gen-tracker.json");

        let mut tracker = GenerationTracker::new(0);
        tracker.bump();
        tracker.save_with_status(&path, false).unwrap();
        assert!(
            !GenerationTracker::load(&path).last_run_complete(),
            "a tracker saved mid-run must load back as incomplete"
        );

        tracker.save_with_status(&path, true).unwrap();
        assert!(
            GenerationTracker::load(&path).last_run_complete(),
            "a tracker saved by a finished run must load back as complete"
        );

        cleanup(&dir);
    }

    /// An aborted run must not hand the next run a set of mtimes that make its
    /// files look analyzed. `filter_changed_files` cannot see the status flag —
    /// it is the caller's job to override — so this pins the two halves the
    /// caller relies on: the flag says "incomplete", and the mtimes are the ones
    /// from BEFORE the aborted run (the aborted run never got to store its own).
    #[test]
    fn aborted_run_leaves_incomplete_status_and_stale_mtimes() {
        let dir = create_test_tree(&["a.js"]);
        let files = vec![dir.join("a.js")];
        let path = dir.join("gen-tracker.json");

        // A run that finishes: mtimes stored, marked complete.
        let mut tracker = GenerationTracker::new(0);
        tracker.bump();
        update_mtimes(&mut tracker, &files).unwrap();
        tracker.save_with_status(&path, true).unwrap();

        // A second run that dies mid-pipeline: it marks in-progress on entry and
        // never reaches the mtime update.
        let mut second = GenerationTracker::load(&path);
        let gen = second.bump();
        second.save_with_status(&path, false).unwrap();

        let third = GenerationTracker::load(&path);
        assert!(
            !third.last_run_complete(),
            "the run that died left the tracker claiming completion"
        );
        assert_eq!(
            third.current(),
            gen,
            "the generation bump must survive an aborted run, or the next run's stamps collide with it"
        );

        cleanup(&dir);
    }

    /// Trackers written before the `complete` field existed carry no proof that
    /// the run behind them finished — and a machine hit by REG-1197 is holding
    /// exactly such a file, with poisoned mtimes. Absent must therefore read as
    /// untrusted, so upgrading recovers instead of inheriting the silent skip.
    #[test]
    fn tracker_without_completion_field_is_untrusted() {
        let dir = create_test_tree(&["a.js"]);
        let path = dir.join("gen-tracker.json");
        fs::write(
            &path,
            r#"{"generation": 2, "file_mtimes": {"/tmp/a.js": 1700000000000000000}}"#,
        )
        .unwrap();

        let tracker = GenerationTracker::load(&path);
        assert_eq!(tracker.current(), 2, "pre-existing state must still load");
        assert_eq!(tracker.file_mtimes.len(), 1);
        assert!(
            !tracker.last_run_complete(),
            "a tracker with no completion field must not be trusted as complete"
        );

        cleanup(&dir);
    }
}
