//! GraphEngineV2 — adapter wrapping MultiShardStore + ManifestStore
//! behind the GraphStore trait.
//!
//! Translates between v1 record types (NodeRecord/EdgeRecord) used by
//! GraphStore and v2 types (NodeRecordV2/EdgeRecordV2) used by the
//! sharded columnar storage.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::error::Result;
use crate::storage::{AttrQuery, EdgeRecord, FieldDecl, NodeRecord};
use crate::storage_v2::manifest::{
    DurabilityMode, ManifestStore, SnapshotDiff, SnapshotInfo,
};
use crate::storage_v2::multi_shard::MultiShardStore;
use crate::storage_v2::resource::{ResourceManager, SystemResources, TuningProfile};
use crate::storage_v2::compaction::{CompactionConfig, CompactionResult};
use crate::storage_v2::types::{CommitDelta, EdgeRecordV2, NodeRecordV2};
use super::{GraphStore, traversal};

/// Fallback shard count when adaptive tuning is bypassed (tests, etc.).
const DEFAULT_SHARD_COUNT: u16 = 4;

// ── Type Conversion ────────────────────────────────────────────────

/// Convert v2 node record to v1 (for GraphStore return values).
fn node_v2_to_v1(v2: &NodeRecordV2) -> NodeRecord {
    // Extract `exported` from metadata JSON (v2 stores it there).
    let (exported, clean_metadata) = extract_exported_from_metadata(&v2.metadata);

    NodeRecord {
        id: v2.id,
        node_type: Some(v2.node_type.clone()),
        file_id: 0,
        name_offset: 0,
        version: "main".to_string(),
        exported,
        replaces: None,
        deleted: false,
        name: Some(v2.name.clone()),
        file: Some(v2.file.clone()),
        metadata: if clean_metadata.is_empty() {
            None
        } else {
            Some(clean_metadata)
        },
        semantic_id: Some(v2.semantic_id.clone()),
    }
}

/// Extract `exported` field from metadata JSON, returning (exported, remaining_metadata).
fn extract_exported_from_metadata(metadata: &str) -> (bool, String) {
    if metadata.is_empty() {
        return (false, String::new());
    }
    match serde_json::from_str::<serde_json::Value>(metadata) {
        Ok(serde_json::Value::Object(mut map)) => {
            let exported = map
                .remove("__exported")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if map.is_empty() {
                (exported, String::new())
            } else {
                (exported, serde_json::to_string(&map).unwrap_or_default())
            }
        }
        _ => (false, metadata.to_string()),
    }
}

/// Inject `exported` field into metadata JSON.
fn inject_exported_into_metadata(metadata: &str, exported: bool) -> String {
    if !exported {
        return metadata.to_string();
    }
    if metadata.is_empty() {
        return r#"{"__exported":true}"#.to_string();
    }
    match serde_json::from_str::<serde_json::Value>(metadata) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.insert(
                "__exported".to_string(),
                serde_json::Value::Bool(true),
            );
            serde_json::to_string(&map).unwrap_or_default()
        }
        _ => metadata.to_string(),
    }
}

/// Convert v1 node record to v2 (for GraphStore input).
fn node_v1_to_v2(v1: &NodeRecord) -> NodeRecordV2 {
    let node_type = v1.node_type.as_deref().unwrap_or("UNKNOWN");
    let name = v1.name.as_deref().unwrap_or("");
    let file = v1.file.as_deref().unwrap_or("");
    let metadata = v1.metadata.as_deref().unwrap_or("");

    // Use client-provided semantic_id if available, otherwise synthesize.
    let semantic_id = v1.semantic_id.clone()
        .unwrap_or_else(|| format!("{}:{}@{}", node_type, name, file));

    // Inject `exported` into metadata JSON (v2 stores it there).
    let metadata = inject_exported_into_metadata(metadata, v1.exported);

    NodeRecordV2 {
        semantic_id,
        id: v1.id,
        node_type: node_type.to_string(),
        name: name.to_string(),
        file: file.to_string(),
        content_hash: 0,
        metadata,
    }
}

/// Convert v2 edge record to v1 (for GraphStore return values).
fn edge_v2_to_v1(v2: &EdgeRecordV2) -> EdgeRecord {
    EdgeRecord {
        src: v2.src,
        dst: v2.dst,
        edge_type: Some(v2.edge_type.clone()),
        version: "main".to_string(),
        metadata: if v2.metadata.is_empty() {
            None
        } else {
            Some(v2.metadata.clone())
        },
        deleted: false,
    }
}

/// Convert v1 edge record to v2 (for GraphStore input).
fn edge_v1_to_v2(v1: &EdgeRecord) -> EdgeRecordV2 {
    EdgeRecordV2 {
        src: v1.src,
        dst: v1.dst,
        edge_type: v1.edge_type.as_deref().unwrap_or("UNKNOWN").to_string(),
        metadata: v1.metadata.as_deref().unwrap_or("").to_string(),
    }
}

// ── GraphEngineV2 ──────────────────────────────────────────────────

/// Graph engine backed by v2 sharded columnar storage.
///
/// Wraps MultiShardStore + ManifestStore and implements the GraphStore
/// trait, translating between v1 and v2 record types at the boundary.
///
/// Soft-deletes are buffered in memory (pending tombstones) and applied
/// on flush.
pub struct GraphEngineV2 {
    store: MultiShardStore,
    /// MVCC B4: the manifest is the single commit-point serialization handle.
    /// Behind a `Mutex` so concurrent `commit_batch` calls (running under the
    /// server's shared `read()` lock) can take the short commit-point lock while
    /// the exclusive `&mut self` paths use `get_mut()` (no contention).
    manifest: std::sync::Mutex<ManifestStore>,
    #[allow(dead_code)]
    path: Option<PathBuf>,
    #[allow(dead_code)]
    ephemeral: bool,
    /// Node IDs marked for deletion but not yet flushed.
    pending_tombstone_nodes: HashSet<u128>,
    /// Edge keys marked for deletion but not yet flushed.
    /// Uses Arc<str> for edge type deduplication — ~15 distinct values
    /// shared across millions of tombstone entries.
    pending_tombstone_edges: HashSet<(u128, u128, Arc<str>)>,
    /// Declared metadata fields for indexing (v1 compat).
    declared_fields: Vec<FieldDecl>,
    /// Cached tuning profile — avoids re-probing sysinfo on every write.
    cached_profile: TuningProfile,
    /// Timestamp of last resource re-detection (rate-limits sysinfo calls).
    last_resource_check: Instant,
    /// Embedding engine for semantic search (None when feature disabled or not initialized).
    #[cfg(feature = "embedding")]
    embedding_engine: Option<std::sync::Arc<crate::embedding::EmbeddingEngine>>,
    /// MVCC C3.a: `true` between `begin_bulk_load` and `end_bulk_load`. While set,
    /// the serial `&mut self` commit path auto-triggers L0→L1 compaction once the
    /// live L0 segment count per shard crosses [`Self::auto_compact_threshold`],
    /// so the live segment count stays bounded (and the O(segments) per-commit
    /// capture/append cost stays ~flat). Disk-for-speed: superseded L0 files are
    /// left on disk in-run and reclaimed at `end_bulk_load` (C3.c).
    bulk_load_active: bool,
    /// MVCC C3.a: per-shard live L0 segment count that triggers auto-compaction
    /// during bulk-load. Reasonable default (8); tuning is out of scope.
    auto_compact_threshold: usize,
    /// MVCC C3.a: count of auto-compaction rounds fired during bulk-load
    /// (diagnostics / acceptance bench).
    auto_compactions: u64,
    /// Gate D2: per-program cross-call cache of `(pinned prior snapshot, prior Evaluation)`
    /// for work-proportional `@materialize`. Keyed by a stable hash of the program source. A
    /// cache hit lets [`Self::eval_datalog_v2_materialize_cached`] MAINTAIN (delta-seeded)
    /// instead of full-eval; a miss (first run / restart / outside the monotone envelope) falls
    /// back to a full eval. Holding the [`ReadSnapshot`] pins that version (its segments survive
    /// GC); replacing the entry drops the old pin, so retained disk is bounded to one prior
    /// generation per materialized program.
    datalog2_materialize_cache: std::collections::HashMap<
        u64,
        (
            crate::storage_v2::read_snapshot::ReadSnapshot,
            crate::datalog2::exec::Evaluation,
        ),
    >,
    /// Test-only: counts how many times [`Self::derive_for_materialize`] took the work-
    /// proportional MAINTAIN path (vs a from-scratch recompute). Lets the cached-materialize
    /// proof assert the incremental path actually fired — a correctness-only check can't, since
    /// maintain and scratch yield identical results by construction. Per-engine (no cross-test
    /// race); atomic so it can be bumped through `&self`.
    #[cfg(test)]
    datalog2_maintain_hits: std::sync::atomic::AtomicU64,
}

// ── Constructors ────────────────────────────────────────────────────

impl GraphEngineV2 {
    /// Create a new database on disk at the given path.
    ///
    /// Uses `ResourceManager::auto_tune()` to determine shard count
    /// based on available RAM and CPU cores.
    pub fn create<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = path.as_ref();
        std::fs::create_dir_all(path)?;
        let profile = ResourceManager::auto_tune();
        let store = MultiShardStore::create(path, profile.shard_count)?;
        let manifest = ManifestStore::create(path)?;

        Ok(Self {
            store,
            manifest: std::sync::Mutex::new(manifest),
            path: Some(path.to_path_buf()),
            ephemeral: false,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            declared_fields: Vec::new(),
            cached_profile: profile,
            last_resource_check: Instant::now(),
            bulk_load_active: false,
            auto_compact_threshold: 8,
            auto_compactions: 0,
            datalog2_materialize_cache: std::collections::HashMap::new(),
            #[cfg(test)]
            datalog2_maintain_hits: std::sync::atomic::AtomicU64::new(0),
            #[cfg(feature = "embedding")]
            embedding_engine: Self::init_embedding_engine(Some(path)),
        })
    }

    /// Create an ephemeral (in-memory only) engine for tests.
    pub fn create_ephemeral() -> Self {
        Self {
            store: MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT),
            manifest: std::sync::Mutex::new(ManifestStore::ephemeral()),
            path: None,
            ephemeral: true,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            declared_fields: Vec::new(),
            cached_profile: TuningProfile::default(),
            last_resource_check: Instant::now(),
            bulk_load_active: false,
            auto_compact_threshold: 8,
            auto_compactions: 0,
            datalog2_materialize_cache: std::collections::HashMap::new(),
            #[cfg(test)]
            datalog2_maintain_hits: std::sync::atomic::AtomicU64::new(0),
            #[cfg(feature = "embedding")]
            embedding_engine: None,
        }
    }

    /// Open an existing database from disk.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = path.as_ref();
        let manifest = ManifestStore::open(path)?;
        let mut store = MultiShardStore::open(path, &manifest)?;

        // MVCC B3: the manifest version is the snapshot/tombstone authority and
        // `ManifestStore::open` already reconstructed its cumulative set (replay
        // into current.tombstoned_* → derived current_tombstones Arc). Here we
        // ALSO mirror that set into the per-shard TombstoneSet for the legacy
        // live-read and compaction-merge paths (B3 Option A). Engine's
        // pending_tombstone_* stays empty — committed deletes live in the version.
        let current = manifest.current();
        if !current.tombstoned_node_ids.is_empty() || !current.tombstoned_edge_keys.is_empty() {
            let tombstone_nodes: HashSet<u128> =
                current.tombstoned_node_ids.iter().copied().collect();
            let tombstone_edges: HashSet<(u128, u128, Arc<str>)> =
                current.tombstoned_edge_keys.iter()
                    .map(|(s, d, t)| (*s, *d, Arc::from(t.as_str())))
                    .collect();
            store.set_tombstones(&tombstone_nodes, &tombstone_edges);
        }

        let profile = ResourceManager::auto_tune();

        Ok(Self {
            store,
            manifest: std::sync::Mutex::new(manifest),
            path: Some(path.to_path_buf()),
            ephemeral: false,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            declared_fields: Vec::new(),
            cached_profile: profile,
            last_resource_check: Instant::now(),
            bulk_load_active: false,
            auto_compact_threshold: 8,
            auto_compactions: 0,
            datalog2_materialize_cache: std::collections::HashMap::new(),
            #[cfg(test)]
            datalog2_maintain_hits: std::sync::atomic::AtomicU64::new(0),
            #[cfg(feature = "embedding")]
            embedding_engine: Self::init_embedding_engine(Some(path)),
        })
    }

    /// Initialize embedding engine from database path (feature-gated).
    #[cfg(feature = "embedding")]
    fn init_embedding_engine(db_path: Option<&Path>) -> Option<std::sync::Arc<crate::embedding::EmbeddingEngine>> {
        let path = db_path?;
        let lance_dir = path.with_extension("embeddings.lance");
        let model_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".grafema")
            .join("models");
        match crate::embedding::EmbeddingEngine::new(&lance_dir, &model_dir) {
            Ok(engine) => Some(std::sync::Arc::new(engine)),
            Err(e) => {
                tracing::warn!("Embedding engine init failed (non-fatal): {}", e);
                None
            }
        }
    }

    /// Public accessor for the embedding engine.
    #[cfg(feature = "embedding")]
    pub fn embedding_engine(&self) -> Option<&std::sync::Arc<crate::embedding::EmbeddingEngine>> {
        self.embedding_engine.as_ref()
    }
}

// ── Helper: snapshot capture ────────────────────────────────────────

impl GraphEngineV2 {
    /// Capture a version-pinned read snapshot of the current PUBLISHED manifest
    /// version (RFD-71 B2). Every public read on this engine resolves through
    /// such a snapshot via the store's `*_at` methods, so it observes ONLY
    /// committed/published data — never the live `Shard.write_buffer` (uncommitted
    /// adds) and never the engine's `pending_tombstone_*` (uncommitted deletes).
    /// Visibility therefore flips exactly at the phase-8 manifest publish.
    fn snapshot(&self) -> crate::storage_v2::read_snapshot::ReadSnapshot {
        // MVCC B4: the manifest is behind a Mutex; the snapshot capture is a
        // short critical section (clone descriptors + tombstone Arc), released
        // immediately — never held across a read's segment I/O.
        let m = self.manifest.lock().unwrap();
        self.store.snapshot(&m)
    }

    /// Evaluate a Datalog **v2** program over a version-pinned view of this engine and
    /// return the ground tuples derived for `target_predicate`, each as a positional
    /// list of stringified column values (RFD `RFDB_DATALOG_V2` router path, spec P3/I8).
    ///
    /// This is the bridge the server-side kill-switch uses: it captures a
    /// [`crate::storage_v2::read_snapshot::ReadSnapshot`] (pinning the published manifest
    /// version exactly like every other read on this engine, MVCC B5), lends it to a
    /// module-private [`crate::datalog2::storage_glue::BorrowedLsmStorageView`] (so the
    /// storage type never leaks past `datalog2`, I10), and routes through the single v2
    /// eval entry [`crate::datalog2::evaluate`] — there is deliberately no separate
    /// explain fork (I8). The caller maps each positional row onto its head variable
    /// names (the engine does not know the caller's wire shape).
    ///
    /// `events` defaults to the discard sink at this layer; explain capture is a recording
    /// of this same run installed by a future caller, not a second code path.
    pub fn eval_datalog_v2(
        &self,
        source: &str,
        target_predicate: &str,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<Vec<Vec<String>>, crate::datalog2::EvalError> {
        let snapshot = self.snapshot();
        // Compute the planner's relation magnitudes from the SAME pinned snapshot before
        // it moves into the view, so Stats and the eval observe one consistent version.
        // Per-type node counts feed the planner's §7 cardinality oracle so an empty type is
        // estimated at ~0 and placed first (not over-estimated at total_nodes, which trips
        // E-PLAN-003 on rules like beam-* whose node type is absent in this graph). One scan
        // of the pinned snapshot; the eval itself reads more.
        let all_nodes = self.store.find_nodes_at(&snapshot, None, None);
        let mut nodes_by_type: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = crate::datalog2::builtin::Stats {
            total_nodes: all_nodes.len() as u64,
            total_edges: self.store.edge_count_at(&snapshot) as u64,
            nodes_by_type,
        };
        let view = crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);
        let evaluation = crate::datalog2::evaluate(
            &view,
            source,
            stats,
            limits,
            crate::datalog2::events::EventLog::discard(),
        )?;
        let rows = evaluation
            .facts(target_predicate)
            .into_iter()
            .map(|tuple| {
                tuple
                    .iter()
                    .map(value_to_wire_string)
                    .collect::<Vec<String>>()
            })
            .collect();
        Ok(rows)
    }

    /// Read-only WHAT-IF (`sim`): evaluate `source` in the hypothetical world where
    /// `hypothetical_edges` (between EXISTING node ids) are added, and return the
    /// `target_predicate` facts that are NEW versus the committed graph — WITHOUT committing.
    ///
    /// The engine seam for sim() — the hypothetical-questions dual of [`Self::explain_datalog_fact`]
    /// (PUG-style why-not): a coverage gap names an unbound premise; sim proves a candidate edge
    /// closes it. It lends ONE pinned snapshot (MVCC B5) to a read-only `BorrowedLsmStorageView`,
    /// overlays an in-memory [`crate::datalog2::storage_glue::OverlayStorageView`] carrying only the
    /// hypothetical edges (their endpoints' attrs resolve from the base), and runs the single v2
    /// eval entry over BOTH base and overlay at the SAME version; the answer is `sim ∖ base`. The
    /// committed store is never touched (read snapshot + in-memory delta, no manifest flip).
    ///
    /// The overlay path is proven sound on the real store
    /// (`datalog2::differential::…::sim_on_real_store_predicts_new_depends_without_commit`,
    /// `sim ≡ scratch(base ∪ Δ)`). `hypothetical_nodes` are `(id, node_type, name, file)` and
    /// `hypothetical_edges` are `(src, dst, edge_type)`; an edge may reference a hypothetical node
    /// (so sim can add a wholly new import binding, not only bridge existing nodes). A richer wire
    /// API (retract / metadata) can reshape this — it is the internal seam, not a committed contract.
    pub fn sim_datalog_v2(
        &self,
        source: &str,
        target_predicate: &str,
        hypothetical_nodes: &[(u128, String, String, String)],
        hypothetical_edges: &[(u128, u128, String)],
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<Vec<Vec<String>>, crate::datalog2::EvalError> {
        let snapshot = self.snapshot();
        let all_nodes = self.store.find_nodes_at(&snapshot, None, None);
        let mut nodes_by_type: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = crate::datalog2::builtin::Stats {
            total_nodes: all_nodes.len() as u64,
            total_edges: self.store.edge_count_at(&snapshot) as u64,
            nodes_by_type,
        };
        let base = crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);

        // Base world.
        let base_eval = crate::datalog2::evaluate(
            &base,
            source,
            stats.clone(),
            limits.clone(),
            crate::datalog2::events::EventLog::discard(),
        )?;
        let base_set: std::collections::HashSet<Vec<String>> = base_eval
            .facts(target_predicate)
            .into_iter()
            .map(|t| t.iter().map(value_to_wire_string).collect::<Vec<String>>())
            .collect();

        // Hypothetical world: overlay the added nodes + edges (existing endpoints' attrs resolve
        // from the base; a hypothetical edge may reference a hypothetical node).
        let mut delta = crate::datalog2::storage_glue::FixtureStorageView::new(0);
        for (id, node_type, name, file) in hypothetical_nodes {
            delta.put_node(crate::datalog2::storage_glue::NodeRow {
                id: *id,
                node_type: node_type.clone(),
                name: name.clone(),
                file: file.clone(),
            });
        }
        for (src, dst, ty) in hypothetical_edges {
            delta.put_edge(crate::datalog2::storage_glue::EdgeRow {
                src: *src,
                dst: *dst,
                edge_type: ty.clone(),
            });
        }
        let overlay = crate::datalog2::storage_glue::OverlayStorageView::new(&base, delta);
        let sim_eval = crate::datalog2::evaluate(
            &overlay,
            source,
            stats,
            limits,
            crate::datalog2::events::EventLog::discard(),
        )?;

        // Answer = sim ∖ base: the NEW facts the hypothetical edits would create.
        let added = sim_eval
            .facts(target_predicate)
            .into_iter()
            .map(|t| t.iter().map(value_to_wire_string).collect::<Vec<String>>())
            .filter(|row| !base_set.contains(row))
            .collect();
        Ok(added)
    }

    /// Evaluate a Datalog **v2** program and write back every `@materialize(edge_type="T")`
    /// predicate's derived facts AS graph edges — the v2 `@materialize` write-back path
    /// (Gate B Stage 1).
    ///
    /// # Run isolation + single atomic flip
    ///
    /// The whole run is staged under ONE generation and committed with a SINGLE atomic
    /// manifest flip:
    ///
    /// 1. Capture a version-pinned snapshot (the read generation) and run the single v2
    ///    eval entry ([`crate::datalog2::evaluate_with_materialize`]) to the fixpoint. The
    ///    target generation is `snapshot.version + 1` — the version the written edges
    ///    become visible at (the orchestrator's `_generation` convention).
    /// 2. Project ALL `@materialize` predicates of the run to one [`EdgeRecordV2`] batch,
    ///    each stamped `{"_source": rule_ast_hash, "_generation": generation}`.
    /// 3. Commit the entire batch with a SINGLE [`Self::commit_batch_ext`] (empty
    ///    `changed_files` → additive, no tombstoning of existing data; the underlying
    ///    `commit_batch_ext` flips the manifest exactly once via `commit_edit`).
    ///
    /// A mid-run failure (parse/stratify/plan/exec/mis-shaped materialized head) returns
    /// the error BEFORE step 3, so nothing is committed and the prior committed generation
    /// stays intact (abort-no-commit). When no rule carries `@materialize`, the run derives
    /// facts and commits nothing (0 edges).
    ///
    /// Returns the number of edges written back.
    pub fn eval_datalog_v2_materialize(
        &mut self,
        source: &str,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<usize, crate::datalog2::EvalError> {
        // ── Step 1: pinned snapshot + fixpoint (the read generation). ──
        let snapshot = self.snapshot();
        // The generation the written edges become visible at is one past the pinned read
        // version (the version commit_batch_ext will publish for this run).
        let generation = snapshot.version + 1;

        let all_nodes = self.store.find_nodes_at(&snapshot, None, None);
        let mut nodes_by_type: std::collections::HashMap<String, u64> =
            std::collections::HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = crate::datalog2::builtin::Stats {
            total_nodes: all_nodes.len() as u64,
            total_edges: self.store.edge_count_at(&snapshot) as u64,
            nodes_by_type,
        };

        let (evaluation, specs) = {
            let view =
                crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);
            crate::datalog2::evaluate_with_materialize(
                &view,
                source,
                stats,
                limits,
                crate::datalog2::events::EventLog::discard(),
            )?
        };

        // ── Step 2: project ALL @materialize predicates → one edge batch. ──
        // A mis-shaped materialized head aborts here (coded), before any commit.
        let edges =
            crate::datalog2::materialize::plan_writeback(&specs, &evaluation, generation)?;
        if edges.is_empty() {
            return Ok(0);
        }
        let written = edges.len();

        // ── Step 3: single atomic commit (one manifest flip). ──
        // Empty `changed_files` ⇒ additive (no tombstoning of existing nodes/edges); the
        // whole run's edges land under `generation` with a single `commit_edit`.
        self.commit_batch_ext(Vec::new(), edges, &[], std::collections::HashMap::new(), &[])
            .map_err(|e| {
                crate::datalog2::EvalError::Materialize(crate::datalog2::materialize::MaterializeError {
                    code: "E-MAT-004",
                    detail: format!("@materialize write-back commit failed: {e}"),
                })
            })?;

        Ok(written)
    }

    /// Incrementally maintain a Datalog program's derived relations against the CURRENT
    /// committed snapshot, given the prior run's result `prev` and the `prev_snapshot` it was
    /// computed at — the real-storage entry behind incremental `@materialize` (spec §9, the
    /// Gate C EXIT on live `storage_v2`).
    ///
    /// Diffs the base relations between the two version-pinned snapshots
    /// ([`crate::datalog2::increment::diff_base`]) and replays the change through
    /// [`crate::datalog2::exec::maintain_incremental`] (DRed deletion + insertion). Returns the
    /// maintained [`Evaluation`] — provably equal to a from-scratch eval of the current
    /// snapshot — for the sound monotone envelope, or `Ok(None)` when the program is outside
    /// it (negation / multiple derived strata) and the caller must recompute from scratch. A
    /// pure read over the two snapshots: no commit happens here (projecting the maintained
    /// relations back to edges is the write-back caller's concern).
    pub fn maintain_datalog_v2(
        &self,
        source: &str,
        prev: &crate::datalog2::exec::Evaluation,
        prev_snapshot: crate::storage_v2::read_snapshot::ReadSnapshot,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<Option<crate::datalog2::exec::Evaluation>, crate::datalog2::EvalError>
    {
        let program = crate::datalog2::parser_ext::parse_ext_program(source)?;
        let strat = crate::datalog2::stratify::stratify(&program)?;
        let rules = program.rules();

        let cur_snapshot = self.snapshot();
        let all_nodes = self.store.find_nodes_at(&cur_snapshot, None, None);
        let mut nodes_by_type: std::collections::HashMap<String, u64> =
            std::collections::HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = crate::datalog2::builtin::Stats {
            total_nodes: all_nodes.len() as u64,
            total_edges: self.store.edge_count_at(&cur_snapshot) as u64,
            nodes_by_type,
        };
        let plans = crate::datalog2::plan::plan_program(&rules, &strat, &stats)?;

        let prev_view =
            crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&self.store, prev_snapshot);
        let cur_view =
            crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&self.store, cur_snapshot);
        let base_delta = crate::datalog2::increment::diff_base(&prev_view, &cur_view);

        let maintained = crate::datalog2::exec::maintain_incremental::<crate::datalog2::tag::BoolTag>(
            prev,
            &prev_view,
            &cur_view,
            &base_delta,
            &plans,
            &rules,
            &strat,
            limits,
        )?;
        Ok(maintained)
    }

    /// why(): explain ONE supporting derivation of a derived fact `pred(key)` against the
    /// current committed snapshot (spec §11; the engine primitive behind the Gate E MCP
    /// `explain_fact`). Returns the rule that derived it and the ground body facts that
    /// satisfied that rule, or `None` if the fact is not derivable by the program. Provenance
    /// is computed on demand — nothing is stored per derived fact.
    pub fn explain_datalog_fact(
        &self,
        source: &str,
        predicate: &str,
        key: &[crate::datalog::Value],
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<
        Option<crate::datalog2::exec::DerivationWitness>,
        crate::datalog2::EvalError,
    > {
        let program = crate::datalog2::parser_ext::parse_ext_program(source)?;
        let strat = crate::datalog2::stratify::stratify(&program)?;
        let rules = program.rules();
        let snapshot = self.snapshot();
        let all_nodes = self.store.find_nodes_at(&snapshot, None, None);
        let mut nodes_by_type: std::collections::HashMap<String, u64> =
            std::collections::HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = crate::datalog2::builtin::Stats {
            total_nodes: all_nodes.len() as u64,
            total_edges: self.store.edge_count_at(&snapshot) as u64,
            nodes_by_type,
        };
        let plans = crate::datalog2::plan::plan_program(&rules, &strat, &stats)?;
        let view =
            crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);
        let witness = crate::datalog2::exec::explain_fact::<crate::datalog2::tag::BoolTag>(
            &view, &plans, &rules, &strat, predicate, key, limits,
        )?;
        Ok(witness)
    }

    /// why-NOT (`explain_gap`): explain why `predicate(key)` is NOT derived — the unbound
    /// premise that, if supplied, would close the gap (spec §6 coverage). The engine wrapper
    /// for [`crate::datalog2::exec::explain_gap`], mirroring [`Self::explain_datalog_fact`]
    /// exactly (one pinned snapshot → BorrowedLsmStorageView → full eval + head-bound replay).
    /// `None` when the fact is actually derivable (no gap) or no clause head matches the key.
    /// The companion to [`Self::sim_datalog_v2`]: this names the missing premise, sim verifies
    /// that adding it produces the fact.
    pub fn explain_datalog_gap(
        &self,
        source: &str,
        predicate: &str,
        key: &[crate::datalog::Value],
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<
        Option<crate::datalog2::exec::GapWitness>,
        crate::datalog2::EvalError,
    > {
        let program = crate::datalog2::parser_ext::parse_ext_program(source)?;
        let strat = crate::datalog2::stratify::stratify(&program)?;
        let rules = program.rules();
        let snapshot = self.snapshot();
        let all_nodes = self.store.find_nodes_at(&snapshot, None, None);
        let mut nodes_by_type: std::collections::HashMap<String, u64> =
            std::collections::HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = crate::datalog2::builtin::Stats {
            total_nodes: all_nodes.len() as u64,
            total_edges: self.store.edge_count_at(&snapshot) as u64,
            nodes_by_type,
        };
        let plans = crate::datalog2::plan::plan_program(&rules, &strat, &stats)?;
        let view =
            crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);
        let gap = crate::datalog2::exec::explain_gap::<crate::datalog2::tag::BoolTag>(
            &view, &plans, &rules, &strat, predicate, key, limits,
        )?;
        Ok(gap)
    }

    /// Incremental `@materialize` write-back (Gate D): re-materialize a program but commit
    /// only the EDGE DELTA against what is already in the graph, instead of rewriting every
    /// derived edge each run. Returns `(added, removed)` edge counts.
    ///
    /// The currently-materialized edges of each `@materialize(edge_type)` ARE the prior
    /// derived state (no extra cross-run storage): diff the freshly-derived edge set against
    /// them by `(src, dst, edge_type)` identity — facts new this run are ADDED (buffered),
    /// facts gone this run are REMOVED (edge-tombstoned). A single [`Self::flush`] applies the
    /// additions and tombstones together (one manifest advance, run isolation). A mis-shaped
    /// materialized head aborts in [`plan_writeback`] BEFORE any mutation (abort-no-commit).
    ///
    /// NOTE: the derivation here is a full evaluation; making it work-proportional (wiring
    /// `maintain_datalog_v2` with a pinned prior snapshot) is the perf half of Gate D. This
    /// commit makes the WRITE incremental; the DERIVE-incremental is the follow-up.
    pub fn eval_datalog_v2_materialize_incremental(
        &mut self,
        source: &str,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<(usize, usize), crate::datalog2::EvalError> {
        // ── Phase 1: derive (full eval) then commit only the edge delta. ──
        let snapshot = self.snapshot();
        let generation = snapshot.version + 1;
        let all_nodes = self.store.find_nodes_at(&snapshot, None, None);
        let mut nodes_by_type: HashMap<String, u64> = HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = crate::datalog2::builtin::Stats {
            total_nodes: all_nodes.len() as u64,
            total_edges: self.store.edge_count_at(&snapshot) as u64,
            nodes_by_type,
        };
        let (evaluation, specs) = {
            let view = crate::datalog2::storage_glue::BorrowedLsmStorageView::new(
                &self.store,
                snapshot.clone(),
            );
            crate::datalog2::evaluate_with_materialize(
                &view,
                source,
                stats,
                limits,
                crate::datalog2::events::EventLog::discard(),
            )?
        };
        self.materialize_writeback_delta(&evaluation, &specs, &snapshot, generation)
    }

    /// Work-proportional `@materialize` (Gate D2): incrementally MAINTAIN the program's derived
    /// relations against the current snapshot — given the prior run's result `prev` and the
    /// `prev_snapshot` it was computed at — then commit only the resulting edge delta. The
    /// derive is delta-seeded ([`Self::maintain_datalog_v2`]); the write is delta-only
    /// ([`Self::materialize_writeback_delta`]). Returns `(added, removed)` edge counts.
    ///
    /// Outside the sound monotone envelope (negation / multiple derived strata) maintenance
    /// returns `None` and this falls back to a full from-scratch evaluation — never a silently
    /// wrong answer (I5). The write-back is byte-identical to the full incremental path; only
    /// how the derived `Evaluation` is produced (maintained vs scratch) differs.
    pub fn eval_datalog_v2_maintain_writeback(
        &mut self,
        source: &str,
        prev: &crate::datalog2::exec::Evaluation,
        prev_snapshot: crate::storage_v2::read_snapshot::ReadSnapshot,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<(usize, usize), crate::datalog2::EvalError> {
        let snapshot = self.snapshot();
        let generation = snapshot.version + 1;
        // Specs come from a parse alone (no eval needed) — the maintained branch must know the
        // target edge types without re-deriving.
        let program = crate::datalog2::parser_ext::parse_ext_program(source)?;
        let specs = crate::datalog2::materialize::collect_materialize_specs(&program)?;

        let evaluation =
            self.derive_for_materialize(source, Some((prev_snapshot, prev)), &snapshot, limits)?;
        self.materialize_writeback_delta(&evaluation, &specs, &snapshot, generation)
    }

    /// Work-proportional `@materialize` with an in-engine cross-call cache (Gate D2). On a cache
    /// hit, MAINTAIN the derived relations against the prior pinned snapshot (delta-seeded) and
    /// commit only the edge delta; on a miss (first run / process restart / a program that falls
    /// outside the monotone envelope) recompute from scratch (the correctness floor, I5). Either
    /// way the cache is refreshed to the current snapshot + result, so the NEXT call is
    /// work-proportional — and replacing the entry drops the prior snapshot's pin (bounded disk).
    ///
    /// Requires no API/wire/orchestrator change: the existing `materialize_datalog("")` call
    /// transparently gets the work-proportional path on its 2nd+ invocation against a long-lived
    /// engine. Durable-across-restart pinning is the named follow-up; this is its prerequisite.
    pub fn eval_datalog_v2_materialize_cached(
        &mut self,
        source: &str,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<(usize, usize), crate::datalog2::EvalError> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        source.hash(&mut hasher);
        let key = hasher.finish();

        let snapshot = self.snapshot();
        let generation = snapshot.version + 1;
        let program = crate::datalog2::parser_ext::parse_ext_program(source)?;
        let specs = crate::datalog2::materialize::collect_materialize_specs(&program)?;

        // Clone the prior entry out so the `&self` maintain borrow doesn't collide with the
        // `&mut self` write-back; cloning the ReadSnapshot bumps its pin (released on drop).
        let prior_owned = self.datalog2_materialize_cache.get(&key).cloned();
        let evaluation = {
            let prior = prior_owned.as_ref().map(|(s, e)| (s.clone(), e));
            self.derive_for_materialize(source, prior, &snapshot, limits)?
        };

        let counts = self.materialize_writeback_delta(&evaluation, &specs, &snapshot, generation)?;
        // Refresh the cache to this generation (drops & unpins the previous one).
        self.datalog2_materialize_cache.insert(key, (snapshot, evaluation));
        Ok(counts)
    }

    /// Produce the derived `Evaluation` for a `@materialize` run: MAINTAIN against a prior pinned
    /// `(snapshot, Evaluation)` when one is supplied AND the program stays inside the monotone
    /// envelope; otherwise (no prior, or maintenance returned `None`) recompute from scratch.
    /// Shared by the explicit-prev ([`Self::eval_datalog_v2_maintain_writeback`]) and cached
    /// ([`Self::eval_datalog_v2_materialize_cached`]) entries.
    fn derive_for_materialize(
        &self,
        source: &str,
        prior: Option<(
            crate::storage_v2::read_snapshot::ReadSnapshot,
            &crate::datalog2::exec::Evaluation,
        )>,
        cur_snapshot: &crate::storage_v2::read_snapshot::ReadSnapshot,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<crate::datalog2::exec::Evaluation, crate::datalog2::EvalError> {
        if let Some((prev_snapshot, prev)) = prior {
            if let Some(e) = self.maintain_datalog_v2(source, prev, prev_snapshot, limits.clone())? {
                #[cfg(test)]
                self.datalog2_maintain_hits
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return Ok(e);
            }
        }
        self.evaluate_materialize_scratch(source, cur_snapshot, limits)
    }

    /// Full from-scratch derivation of a `@materialize` program at a pinned snapshot (the
    /// correctness floor for [`Self::derive_for_materialize`]).
    fn evaluate_materialize_scratch(
        &self,
        source: &str,
        snapshot: &crate::storage_v2::read_snapshot::ReadSnapshot,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<crate::datalog2::exec::Evaluation, crate::datalog2::EvalError> {
        let all_nodes = self.store.find_nodes_at(snapshot, None, None);
        let mut nodes_by_type: HashMap<String, u64> = HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = crate::datalog2::builtin::Stats {
            total_nodes: all_nodes.len() as u64,
            total_edges: self.store.edge_count_at(snapshot) as u64,
            nodes_by_type,
        };
        let view = crate::datalog2::storage_glue::BorrowedLsmStorageView::new(
            &self.store,
            snapshot.clone(),
        );
        Ok(crate::datalog2::evaluate_with_materialize(
            &view,
            source,
            stats,
            limits,
            crate::datalog2::events::EventLog::discard(),
        )?
        .0)
    }

    /// Commit ONLY the edge delta of a freshly-derived `@materialize` result against what is
    /// already in the graph: the currently-materialized edges of each spec's `edge_type` ARE
    /// the prior derived state (no extra cross-run storage). Facts new this run are added
    /// (buffered); facts gone this run are edge-tombstoned. A single [`Self::flush`] applies the
    /// additions and tombstones together (one manifest advance, run isolation). A mis-shaped
    /// materialized head aborts in [`plan_writeback`] BEFORE any mutation (abort-no-commit).
    /// Returns `(added, removed)` edge counts. Shared by the full-incremental and
    /// maintain-incremental `@materialize` entries.
    fn materialize_writeback_delta(
        &mut self,
        evaluation: &crate::datalog2::exec::Evaluation,
        specs: &[crate::datalog2::materialize::MaterializeSpec],
        snapshot: &crate::storage_v2::read_snapshot::ReadSnapshot,
        generation: u64,
    ) -> std::result::Result<(usize, usize), crate::datalog2::EvalError> {
        use std::collections::HashSet;

        // The full derived edge set (also the abort-no-commit shape check).
        let new_edges =
            crate::datalog2::materialize::plan_writeback(specs, evaluation, generation)?;
        let new_keys: HashSet<(u128, u128, String)> = new_edges
            .iter()
            .map(|e| (e.src, e.dst, e.edge_type.clone()))
            .collect();
        // The prior derived state IS the currently-materialized edges of the spec types.
        // An ADDITIVE type (any of its specs carries `mode = "additive"`) is shared with
        // other producers (analyzers, enrichers): its stored edges are used only to dedup
        // additions and are NEVER tombstoned — exclusive ownership is what the default
        // mode means, and claiming it over a shared type would delete the other producers'
        // edges (e.g. `@materialize(edge_type = "CALLS")` would strip analyzer CALLS).
        let edge_types: HashSet<String> = specs.iter().map(|s| s.edge_type.clone()).collect();
        let additive_types: HashSet<String> = specs
            .iter()
            .filter(|s| s.additive)
            .map(|s| s.edge_type.clone())
            .collect();
        let mut prev_keys: HashSet<(u128, u128, String)> = HashSet::new();
        for t in &edge_types {
            for e in self.store.get_edges_by_type_at(snapshot, t) {
                prev_keys.insert((e.src, e.dst, e.edge_type.clone()));
            }
        }
        let added: Vec<EdgeRecordV2> = new_edges
            .into_iter()
            .filter(|e| !prev_keys.contains(&(e.src, e.dst, e.edge_type.clone())))
            .collect();
        let removed: Vec<(u128, u128, String)> = prev_keys
            .into_iter()
            .filter(|k| !new_keys.contains(k) && !additive_types.contains(&k.2))
            .collect();

        // ── Phase 2: apply the delta (one flush commits adds + tombstones). ──
        let (n_added, n_removed) = (added.len(), removed.len());
        if n_added == 0 && n_removed == 0 {
            return Ok((0, 0));
        }
        for (s, d, t) in &removed {
            self.delete_edge(*s, *d, t);
        }
        if !added.is_empty() {
            let v1: Vec<EdgeRecord> = added.iter().map(edge_v2_to_v1).collect();
            self.add_edges(v1, true);
        }
        self.flush().map_err(|e| {
            crate::datalog2::EvalError::Materialize(crate::datalog2::materialize::MaterializeError {
                code: "E-MAT-005",
                detail: format!("incremental @materialize write-back flush failed: {e}"),
            })
        })?;
        Ok((n_added, n_removed))
    }
}

/// Stringify a v2 Datalog [`crate::datalog::Value`] for the wire (ids render as their
/// decimal u128, mirroring how v1 surfaces `Value::Id`/`Value::Str` to `WireViolation`).
fn value_to_wire_string(v: &crate::datalog::Value) -> String {
    match v {
        crate::datalog::Value::Id(id) => id.to_string(),
        crate::datalog::Value::Str(s) => s.clone(),
        crate::datalog::Value::Int(i) => i.to_string(),
        crate::datalog::Value::Float(f) => f.to_string(),
    }
}

// ── GraphStore Implementation ───────────────────────────────────────

impl GraphStore for GraphEngineV2 {
    fn add_nodes(&mut self, nodes: Vec<NodeRecord>) {
        let v2_nodes: Vec<NodeRecordV2> = nodes.iter().map(node_v1_to_v2).collect();
        // Re-adding a node in the same session must resurrect it immediately.
        // Without this, delete->add keeps the node hidden until flush.
        // The old version may persist in a flushed segment alongside the new
        // write-buffer version, but node_count() deduplicates ids across
        // segments, so no separate "superseded" bookkeeping is needed.
        let readded_ids: HashSet<u128> = v2_nodes.iter().map(|n| n.id).collect();
        for id in &readded_ids {
            self.pending_tombstone_nodes.remove(id);
        }
        // MVCC B3: a re-added node must un-tombstone in the version authority
        // (the manifest), or a previously-COMMITTED delete would re-shadow it on
        // the next flush and after reopen. Mirrors add_edges → remove_tombstone_edges.
        self.manifest.get_mut().unwrap().remove_tombstone_nodes(&readded_ids);
        self.store.add_nodes(v2_nodes);

        // Auto-flush: check if any shard's write buffer exceeds adaptive limits
        // or if system memory pressure is high.
        self.maybe_auto_flush();
    }

    fn delete_node(&mut self, id: u128) {
        // Tombstone the node
        self.pending_tombstone_nodes.insert(id);

        // Also tombstone all connected edges (outgoing + incoming)
        let outgoing = self.store.get_outgoing_edges(id, None);
        for edge in &outgoing {
            self.pending_tombstone_edges.insert((
                edge.src,
                edge.dst,
                Arc::from(edge.edge_type.as_str()),
            ));
        }
        let incoming = self.store.get_incoming_edges(id, None);
        for edge in &incoming {
            self.pending_tombstone_edges.insert((
                edge.src,
                edge.dst,
                Arc::from(edge.edge_type.as_str()),
            ));
        }
    }

    fn get_node(&self, id: u128) -> Option<NodeRecord> {
        // B2: version-pinned read. The snapshot's tombstone set is authoritative
        // for the published version; uncommitted pending tombstones are invisible.
        let snap = self.snapshot();
        self.store.get_node_at(&snap, id).map(|v2| node_v2_to_v1(&v2))
    }

    fn node_exists(&self, id: u128) -> bool {
        let snap = self.snapshot();
        self.store.node_exists_at(&snap, id)
    }

    fn get_node_identifier(&self, id: u128) -> Option<String> {
        self.get_node(id).map(|node| {
            let node_type = node.node_type.as_deref().unwrap_or("UNKNOWN");
            let name = node.name.as_deref().unwrap_or("");
            let file = node.file.as_deref().unwrap_or("");
            format!("{}:{}@{}", node_type, name, file)
        })
    }

    fn find_by_attr(&self, query: &AttrQuery) -> Vec<u128> {
        let node_type_filter = query.node_type.as_deref();

        // Handle wildcard node_type — storage path accepts exact+prefix separately.
        let (exact_type, wildcard_prefix) = match node_type_filter {
            Some(t) if t.ends_with('*') => (None, Some(t.trim_end_matches('*'))),
            other => (other, None),
        };

        // B2: version-pinned read through the published snapshot.
        let snap = self.snapshot();
        let mut ids = self.store.find_node_ids_by_attr_at(
            &snap,
            exact_type,
            wildcard_prefix,
            query.file.as_deref(),
            query.name.as_deref(),
            query.exported,
            &query.metadata_filters,
            query.substring_match,
        );

        // Fuzzy name fallback: when name is specified, 0 exact results,
        // and fuzzy is not explicitly disabled
        if ids.is_empty()
            && query.name.is_some()
            && query.fuzzy_name_fallback != Some(false)
        {
            let name = query.name.as_deref().unwrap();
            let fuzzy_matches = self.store.find_similar_names_at(
                &snap,
                name,
                exact_type,
                20,  // top-K
                0.3, // min Jaccard score
            );
            for m in &fuzzy_matches {
                ids.push(m.node_id);
            }
        }

        // Embedding similarity fallback (tier 4): when token fuzzy also returned nothing
        #[cfg(feature = "embedding")]
        if ids.is_empty()
            && query.name.is_some()
            && query.fuzzy_name_fallback != Some(false)
        {
            if let Some(ref engine) = self.embedding_engine {
                let name = query.name.as_deref().unwrap();
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    let matches = handle.block_on(engine.search(name, exact_type, 10, 0.5));
                    for m in matches {
                        if !snap.tombstones.contains_node(m.node_id) {
                            ids.push(m.node_id);
                        }
                    }
                }
            }
        }

        ids
    }

    fn find_by_attr_chunked(
        &self,
        query: &AttrQuery,
        chunk_size: usize,
        callback: &mut dyn FnMut(&[u128]) -> bool,
    ) {
        let node_type_filter = query.node_type.as_deref();
        let (exact_type, wildcard_prefix) = match node_type_filter {
            Some(t) if t.ends_with('*') => (None, Some(t.trim_end_matches('*'))),
            other => (other, None),
        };

        let mut found_any = false;

        // B2: version-pinned read through the published snapshot.
        let snap = self.snapshot();
        self.store.find_node_ids_by_attr_chunked_at(
            &snap,
            exact_type,
            wildcard_prefix,
            query.file.as_deref(),
            query.name.as_deref(),
            query.exported,
            &query.metadata_filters,
            query.substring_match,
            chunk_size,
            &mut |ids| {
                if !ids.is_empty() { found_any = true; }
                callback(ids)
            },
        );

        // Fuzzy name fallback for streaming path (same logic as find_by_attr)
        if !found_any
            && query.name.is_some()
            && query.fuzzy_name_fallback != Some(false)
        {
            let name = query.name.as_deref().unwrap();
            let fuzzy_matches = self.store.find_similar_names_at(
                &snap,
                name,
                exact_type,
                20,
                0.3,
            );
            let fuzzy_ids: Vec<u128> = fuzzy_matches.iter()
                .map(|m| m.node_id)
                .collect();
            if !fuzzy_ids.is_empty() {
                found_any = true;
                callback(&fuzzy_ids);
            }
        }

        // Embedding similarity fallback for streaming path (tier 4)
        #[cfg(feature = "embedding")]
        if !found_any
            && query.name.is_some()
            && query.fuzzy_name_fallback != Some(false)
        {
            if let Some(ref engine) = self.embedding_engine {
                let name = query.name.as_deref().unwrap();
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    let matches = handle.block_on(engine.search(name, exact_type, 10, 0.5));
                    let emb_ids: Vec<u128> = matches.iter()
                        .filter(|m| !snap.tombstones.contains_node(m.node_id))
                        .map(|m| m.node_id)
                        .collect();
                    if !emb_ids.is_empty() {
                        callback(&emb_ids);
                    }
                }
            }
        }
    }

    fn find_by_type(&self, node_type: &str) -> Vec<u128> {
        // B2: version-pinned read through the published snapshot.
        let snap = self.snapshot();
        if node_type.ends_with('*') {
            self.store.find_node_ids_by_attr_at(
                &snap,
                None,
                Some(node_type.trim_end_matches('*')),
                None,
                None,
                None,
                &[],
                false,
            )
        } else {
            self.store.find_node_ids_by_type_at(&snap, node_type)
        }
    }

    fn add_edges(&mut self, edges: Vec<EdgeRecord>, skip_validation: bool) {
        let v2_edges: Vec<EdgeRecordV2> = edges.iter().map(edge_v1_to_v2).collect();
        // Re-adding an edge in the same session must clear any pending tombstone
        // for the same (src, dst, type) triple.
        let keys: Vec<(u128, u128, Arc<str>)> = v2_edges
            .iter()
            .map(|e| (e.src, e.dst, Arc::from(e.edge_type.as_str())))
            .collect();
        for key in &keys {
            // Edge was deleted then re-added; the old segment version may
            // persist, but edge_count() deduplicates keys across segments.
            self.pending_tombstone_edges.remove(key);
        }
        // Also un-tombstone any keys whose deletion has already been
        // committed (typical for the rule-chain pattern in the compaction
        // enricher: delete-by-source flushes tombstones, then the same
        // `(src, dst, type)` is re-emitted via addEdges). Without this the
        // new edge persists in the write buffer but every read path filters
        // it out via `tombstones.contains_edge`.
        // MVCC B3: the version authority is the manifest — un-tombstone there
        // (so snapshots immediately see the edge live and the next flush does
        // not re-broadcast the stale tombstone) AND in the per-shard mirror
        // (for the legacy live-read paths).
        self.manifest.get_mut().unwrap().remove_tombstone_edges(&keys);
        self.store.untombstone_edges(&keys);
        let result = self.store.upsert_edges(v2_edges);
        if !skip_validation {
            if let Err(e) = result {
                tracing::warn!("upsert_edges error: {}", e);
            }
        }
        // If skip_validation, silently ignore errors

        // Edge-only flush: only trigger on byte limit, never on memory-pressure path.
        // The memory-pressure path checks total_write_buffer_nodes (nodes from the
        // analysis phase), so an enricher's edge write storm would cause a massive
        // node flush while holding the exclusive write lock — blocking all reads for
        // seconds. Edge writes use a byte-only guard instead. (RFD-67)
        self.maybe_auto_flush_edges();
    }

    fn delete_edge(&mut self, src: u128, dst: u128, edge_type: &str) {
        self.pending_tombstone_edges.insert((
            src,
            dst,
            Arc::from(edge_type),
        ));
    }

    fn neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128> {
        // B2: version-pinned read. `*_at` edge queries already drop tombstoned
        // edges via the snapshot; also drop edges whose dst no longer exists in
        // the published version.
        let snap = self.snapshot();
        let edge_types_opt = if edge_types.is_empty() { None } else { Some(edge_types) };
        self.store.get_outgoing_edges_at(&snap, id, edge_types_opt)
            .into_iter()
            .filter(|e| self.store.node_exists_at(&snap, e.dst))
            .map(|e| e.dst)
            .collect()
    }

    fn get_outgoing_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord> {
        let snap = self.snapshot();
        self.store.get_outgoing_edges_at(&snap, node_id, edge_types)
            .iter()
            .map(edge_v2_to_v1)
            .collect()
    }

    fn get_incoming_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord> {
        let snap = self.snapshot();
        self.store.get_incoming_edges_at(&snap, node_id, edge_types)
            .iter()
            .map(edge_v2_to_v1)
            .collect()
    }

    fn get_all_edges(&self) -> Vec<EdgeRecord> {
        let snap = self.snapshot();
        self.store.iter_all_edges_at(&snap)
            .iter()
            .map(edge_v2_to_v1)
            .collect()
    }

    fn get_edges_by_type(&self, edge_type: &str) -> Vec<EdgeRecord> {
        let snap = self.snapshot();
        self.store.get_edges_by_type_at(&snap, edge_type)
            .iter()
            .map(edge_v2_to_v1)
            .collect()
    }

    fn count_nodes_by_type(&self, types: Option<&[String]>) -> HashMap<String, usize> {
        // B2: version-pinned read through the published snapshot.
        let snap = self.snapshot();
        let mut counts: HashMap<String, usize> = HashMap::new();

        match types {
            Some(type_list) => {
                for t in type_list {
                    if t.ends_with('*') {
                        // Wildcard
                        let prefix = t.trim_end_matches('*');
                        let nodes = self.store.find_nodes_at(&snap, None, None);
                        for n in nodes {
                            if n.node_type.starts_with(prefix) {
                                *counts.entry(n.node_type).or_insert(0) += 1;
                            }
                        }
                    } else {
                        let count = self.store.find_nodes_at(&snap, Some(t), None).len();
                        if count > 0 {
                            counts.insert(t.clone(), count);
                        }
                    }
                }
            }
            None => {
                return self.store.count_by_type_at(&snap);
            }
        }

        counts
    }

    fn count_edges_by_type(&self, edge_types: Option<&[String]>) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();

        // Collect all edges via get_all_edges (already filters tombstoned)
        let all_edges = self.get_all_edges();

        for edge in &all_edges {
            let et = edge.edge_type.as_deref().unwrap_or("UNKNOWN");

            match edge_types {
                Some(filter) => {
                    let matches = filter.iter().any(|f| {
                        if f.ends_with('*') {
                            et.starts_with(f.trim_end_matches('*'))
                        } else {
                            et == f
                        }
                    });
                    if matches {
                        *counts.entry(et.to_string()).or_insert(0) += 1;
                    }
                }
                None => {
                    *counts.entry(et.to_string()).or_insert(0) += 1;
                }
            }
        }

        counts
    }

    fn bfs(&self, start: &[u128], max_depth: usize, edge_types: &[&str]) -> Vec<u128> {
        let edge_types_owned: Vec<String> = edge_types.iter().map(|s| s.to_string()).collect();
        traversal::bfs(start, max_depth, |node_id| {
            let types_refs: Vec<&str> = edge_types_owned.iter().map(|s| s.as_str()).collect();
            self.neighbors(node_id, &types_refs)
        })
    }

    fn flush_data_only(&mut self) -> Result<()> {
        // Flush to disk when write buffers exceed safe limits.
        // Previously this was a no-op, relying on compact() at the end
        // of analysis to persist everything. But if analysis fails before
        // compact (OOM, timeout, resolver error), ALL data was lost.
        //
        // Threshold: flush when any shard has >50K nodes or >128MB in buffers.
        // Lowered from 100K/256MB to reduce peak RSS on large graphs (4M+ nodes).
        if self.store.any_shard_needs_flush(50_000, 128 * 1024 * 1024) {
            self.store.flush_all(self.manifest.get_mut().unwrap())?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        // Apply pending tombstones before flushing to disk so delete_node /
        // delete_edge operations are persisted.
        let mut tombstones_changed = false;
        if !self.pending_tombstone_nodes.is_empty() || !self.pending_tombstone_edges.is_empty() {
            // MVCC B3: deletions are version state. Merge them into the current
            // manifest version's cumulative tombstone set so the imminent commit
            // carries them forward and writes them to disk (snapshot authority +
            // reopen fidelity). extend_tombstones also refreshes the version's
            // derived Arc, so reads see the delete immediately.
            tombstones_changed = self.manifest.get_mut().unwrap().extend_tombstones(
                &self.pending_tombstone_nodes,
                &self.pending_tombstone_edges,
            );
            // Keep the per-shard TombstoneSet in sync for the legacy live-read
            // and compaction-merge paths that still consult it (B3 Option A:
            // relocate the snapshot authority to the version; the per-shard
            // field is no longer the authority but still backs those paths).
            // Broadcast the FULL cumulative set (not just this batch's pending)
            // so the per-shard set matches the version — set_tombstones replaces.
            let (full_nodes, full_edges) = {
                let m = self.manifest.lock().unwrap();
                let cur = m.current();
                let full_nodes: HashSet<u128> =
                    cur.tombstoned_node_ids.iter().copied().collect();
                let full_edges: HashSet<(u128, u128, Arc<str>)> = cur
                    .tombstoned_edge_keys
                    .iter()
                    .map(|(s, d, t)| (*s, *d, Arc::from(t.as_str())))
                    .collect();
                (full_nodes, full_edges)
            };
            self.store.set_tombstones(&full_nodes, &full_edges);
            self.pending_tombstone_nodes.clear();
            self.pending_tombstone_edges.clear();
        }
        let flushed = self.store.flush_all(self.manifest.get_mut().unwrap())?;
        // If tombstones changed but there were no segments to flush (write
        // buffers already drained by a prior commit), flush_all advanced no
        // version. Force a tombstone-only version so the delete is persisted.
        if tombstones_changed && flushed == 0 {
            self.manifest.get_mut().unwrap().commit_tombstone_only()?;
        }
        Ok(())
    }

    fn begin_bulk_load(&mut self) -> Result<()> {
        // MVCC C2.3: flip the manifest durability flag to Relaxed. The commit
        // point reads `m.durability()` under the manifest Mutex, so every
        // commit that grabs the lock after this runs with deferred fsync. This
        // method is reached only via the engine write lock (with_engine_write),
        // which serializes against in-flight commits — no race on the flag.
        //
        // MVCC C3.a: arm auto-compaction. While bulk-load is active the serial
        // commit path bounds the live L0 segment count by compacting once a shard
        // crosses the threshold — keeping per-commit capture/append ~flat.
        self.bulk_load_active = true;
        self.auto_compactions = 0;
        self.manifest
            .lock()
            .unwrap()
            .set_durability(DurabilityMode::Relaxed)
    }

    fn end_bulk_load(&mut self) -> Result<()> {
        // MVCC C2.3 / C2.2: first flush any data still in write buffers so the
        // published manifest version reflects all bulk commits, THEN run the
        // durable barrier over that published version, THEN restore Strict.
        //
        // Crash contract (C2.4): if make_durable returns Err, we do NOT flip
        // back to Strict — the barrier is incomplete, and the caller surfaces
        // the error so the operator re-runs (deferred-durability data may be
        // partially on disk; a reopen sees a consistent older-or-equal version,
        // never corruption — current.json is swapped atomically and last).
        self.flush()?;

        // MVCC C3.a: stop arming per-commit auto-compaction, then run ONE final
        // compaction barrier so every shard's bulk L0 is folded into L1 before
        // the durable barrier (bounds the published live segment count).
        self.bulk_load_active = false;
        {
            let config = CompactionConfig { segment_threshold: 1 };
            self.store
                .compact(self.manifest.get_mut().unwrap(), &config)?;
        }

        // MVCC C3.c: bounded disk reclaim. The B5 pin-aware GC retains every
        // segment referenced by a version >= min_pinned (live readers) and by the
        // current published version; everything else (superseded bulk L0 left on
        // disk in-run, disk-for-speed) is moved to gc/ and purged. Disk grows
        // during bulk, drops here to a bounded multiple of logical size.
        self.reclaim_superseded_segments()?;

        {
            let mut m = self.manifest.lock().unwrap();
            m.make_durable()?;
            m.set_durability(DurabilityMode::Strict)?;
        }
        Ok(())
    }

    fn compact(&mut self) -> Result<()> {
        // Flush write buffers to L0 segments first — resolution and derived
        // edge commits use flush_data_only() (no-op in V2), so data may
        // still be in write buffers at compact time.
        self.flush()?;
        // Force-compact all shards with any L0 segments (threshold=1).
        // The default threshold (4) skips shards with few L0 segments,
        // leaving old L1 + new L0 = double-counted nodes/edges.
        let config = CompactionConfig { segment_threshold: 1 };
        self.store.compact(self.manifest.get_mut().unwrap(), &config)?;
        // Manifest GC: remove old manifest files before segment GC so
        // referenced_segments is recalculated and orphaned segments are detected.
        let gc_manifests = self.manifest.get_mut().unwrap().gc_manifests(3)?;
        if gc_manifests > 0 {
            tracing::info!("GC: removed {} old manifest(s)", gc_manifests);
        }
        // Segment GC: collect orphaned segments after compaction + manifest GC
        let moved = self.manifest.get_mut().unwrap().gc_collect()?;
        if !moved.is_empty() {
            tracing::info!("GC: moved {} orphaned segment(s) to gc/", moved.len());
        }
        // Purge: permanently delete collected segments
        let purged = self.manifest.get_mut().unwrap().gc_purge()?;
        if purged > 0 {
            tracing::info!("GC: purged {} segment file(s)", purged);
        }
        Ok(())
    }

    /// V2 engine: rebuild_indexes is a no-op (v2 handles indexes differently).
    fn rebuild_indexes(&mut self) -> Result<()> {
        // V2 engine manages indexes internally — full flush is the rebuild.
        self.flush()
    }

    fn node_count(&self) -> usize {
        // B2: version-pinned count over the published snapshot. Each id is
        // counted once (deduped across the version's segments) and the version's
        // tombstones are excluded. Uncommitted pending tombstones from
        // `delete_node` are NOT reflected until flush publishes them.
        let snap = self.snapshot();
        self.store.node_count_at(&snap)
    }

    fn edge_count(&self) -> usize {
        // B2: version-pinned count over the published snapshot.
        let snap = self.snapshot();
        self.store.edge_count_at(&snap)
    }

    fn clear(&mut self) {
        self.store = MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT);
        self.manifest = std::sync::Mutex::new(ManifestStore::ephemeral());
        self.pending_tombstone_nodes.clear();
        self.pending_tombstone_edges.clear();
        self.declared_fields.clear();
    }

    fn declare_fields(&mut self, fields: Vec<FieldDecl>) {
        self.declared_fields = fields;
    }

    fn shard_diagnostics(&self) -> Vec<crate::storage_v2::ShardDiagnostics> {
        self.store.shard_diagnostics()
    }

    fn disk_size_bytes(&self) -> u64 {
        match &self.path {
            Some(p) => dir_size_bytes(p),
            None => 0,
        }
    }

    fn as_any(&self) -> &dyn std::any::Any { self }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
}

/// Recursively compute total size of a directory in bytes.
fn dir_size_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                total += dir_size_bytes(&entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

// ── Engine-specific Methods (NOT on GraphStore trait) ────────────────

impl GraphEngineV2 {
    /// MVCC C3.a: auto-compaction trigger for the serial (`&mut self`) commit
    /// path during bulk-load. Bounds the live L0 segment count so per-commit
    /// `ReadSnapshot::capture` / descriptor-append cost stays ~flat instead of
    /// climbing with `O(commits)` segments.
    ///
    /// SAFETY / FALLBACK (deliberate, reported): this runs ONLY at the serial
    /// single-writer commit point — it takes `&mut self`, the same exclusive
    /// access the legacy `compact()` requires (compaction reads AND mutates live
    /// in-memory shard state: `set_l1_segments` / `clear_l0_after_compaction` /
    /// the global index). There is NO concurrent commit in flight here (the
    /// engine write lock / `&mut self` excludes them), so this is deadlock-free
    /// and reader-safe BY CONSTRUCTION: the slow L1 rewrite never overlaps a
    /// concurrent `commit_batch_private`, and the B5 pins keep any live reader's
    /// older-version segments alive (compaction publishes new L1 + leaves old L0
    /// on disk; reclaim is deferred to `end_bulk_load`). The fully-concurrent
    /// background-compactor-as-writer variant is NOT taken here because the
    /// existing compaction path is structurally `&mut self` (in-place shard
    /// mutation), so a `&self` background writer would race concurrent appenders
    /// on unguarded shard `Vec`s — a UAF/lost-update surface out of this scope.
    fn maybe_auto_compact(&mut self) -> Result<()> {
        if !self.bulk_load_active {
            return Ok(());
        }
        // Live L0 segment count per shard, from the published version mirrored in
        // shard state. Trigger when ANY shard crosses the threshold.
        let max_l0 = self
            .store
            .shard_diagnostics()
            .iter()
            .map(|d| d.l0_node_segment_count.max(d.l0_edge_segment_count))
            .max()
            .unwrap_or(0);
        if max_l0 < self.auto_compact_threshold {
            return Ok(());
        }
        // Compact every shard with >= threshold L0 segments. Slow L1 rewrite runs
        // here under exclusive `&mut self` — never holding the manifest mutex
        // across the rewrite (compact() publishes via a short commit at the end).
        let config = CompactionConfig {
            segment_threshold: self.auto_compact_threshold,
        };
        self.store
            .compact(self.manifest.get_mut().unwrap(), &config)?;
        self.auto_compactions += 1;
        Ok(())
    }

    /// MVCC C3.c: bounded reclaim of superseded segment files via the B5
    /// pin-aware GC. Removes stale manifest versions (keep last 3), moves
    /// orphaned segments to `gc/` (retaining every segment referenced by a
    /// version `>= min_pinned`, so a live reader's pinned segments survive), then
    /// purges them. Called at `end_bulk_load`; safe to call any time.
    fn reclaim_superseded_segments(&mut self) -> Result<()> {
        let m = self.manifest.get_mut().unwrap();
        let gc_manifests = m.gc_manifests(3)?;
        if gc_manifests > 0 {
            tracing::info!("C3.c reclaim: removed {} old manifest(s)", gc_manifests);
        }
        let moved = m.gc_collect()?;
        if !moved.is_empty() {
            tracing::info!(
                "C3.c reclaim: moved {} orphaned segment(s) to gc/",
                moved.len()
            );
        }
        let purged = m.gc_purge()?;
        if purged > 0 {
            tracing::info!("C3.c reclaim: purged {} segment file(s)", purged);
        }
        Ok(())
    }

    /// MVCC C3.a: number of auto-compaction rounds fired during the last
    /// bulk-load (diagnostics / acceptance bench).
    pub fn auto_compactions(&self) -> u64 {
        self.auto_compactions
    }

    /// MVCC C3.a: set the per-shard live-L0 threshold that triggers auto-compaction
    /// during bulk-load. Larger ⇒ compaction fires less often (more amortization of
    /// the O(total) L1 rewrite, at the cost of a higher live-segment ceiling).
    /// Tuning is out of scope (spec §8); the bench uses this to report sensitivity.
    pub fn set_auto_compact_threshold(&mut self, threshold: usize) {
        self.auto_compact_threshold = threshold.max(1);
    }

    /// Check if a node is an endpoint (for PathValidator).
    ///
    /// Endpoint types: db:query, http:request, http:endpoint,
    /// EXTERNAL, fs:operation, SIDE_EFFECT, exported FUNCTION.
    pub fn is_endpoint(&self, id: u128) -> bool {
        // B2: version-pinned read through the published snapshot.
        let snap = self.snapshot();
        if let Some(v2) = self.store.get_node_at(&snap, id) {
            let node_type = v2.node_type.as_str();

            if matches!(
                node_type,
                "db:query"
                    | "http:request"
                    | "http:endpoint"
                    | "EXTERNAL"
                    | "fs:operation"
                    | "SIDE_EFFECT"
            ) {
                return true;
            }

            // v2 doesn't have an `exported` field on the record —
            // check metadata for {"exported":true}
            if node_type == "FUNCTION" && !v2.metadata.is_empty() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&v2.metadata) {
                    if parsed.get("exported") == Some(&serde_json::Value::Bool(true)) {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// BFS/DFS reachability with optional backward traversal.
    pub fn reachability(
        &self,
        start: &[u128],
        max_depth: usize,
        edge_types: &[&str],
        backward: bool,
    ) -> Vec<u128> {
        let edge_types_owned: Vec<String> = edge_types.iter().map(|s| s.to_string()).collect();

        if backward {
            traversal::bfs(start, max_depth, |node_id| {
                let types_refs: Vec<&str> =
                    edge_types_owned.iter().map(|s| s.as_str()).collect();
                self.reverse_neighbors(node_id, &types_refs)
            })
        } else {
            traversal::bfs(start, max_depth, |node_id| {
                let types_refs: Vec<&str> =
                    edge_types_owned.iter().map(|s| s.as_str()).collect();
                self.neighbors_internal(node_id, &types_refs)
            })
        }
    }

    /// Get the currently declared fields.
    pub fn declared_fields_ref(&self) -> &[FieldDecl] {
        &self.declared_fields
    }

    /// Atomic batch commit (v2-native API).
    pub fn commit_batch(
        &mut self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
    ) -> Result<CommitDelta> {
        self.commit_batch_ext(nodes, edges, changed_files, tags, &[])
    }

    /// Atomic batch commit with protected types.
    ///
    /// Nodes whose `node_type` is in `protected_types` are excluded from
    /// tombstoning during re-analysis of their file.
    pub fn commit_batch_ext(
        &mut self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
        protected_types: &[String],
    ) -> Result<CommitDelta> {
        let delta = self.store
            .commit_batch_ext(nodes, edges, changed_files, tags, self.manifest.get_mut().unwrap(), protected_types)?;

        // MVCC B3: after commit_batch_ext the new version's cumulative tombstone
        // set lives in the manifest VERSION (the authority that snapshots read);
        // the per-shard mirror was refreshed once at the commit point for the
        // legacy live-read paths. The engine's pending sets are cleared.
        self.pending_tombstone_nodes.clear();
        self.pending_tombstone_edges.clear();

        // MVCC C3.a: bound the live L0 segment count during bulk-load. No-op
        // outside bulk-load and below threshold. Runs under exclusive `&mut self`
        // (single-writer) so the L1 rewrite never overlaps a concurrent commit.
        self.maybe_auto_compact()?;

        Ok(delta)
    }

    /// MVCC B4: CONCURRENT atomic batch commit (`&self`).
    ///
    /// Runs the deadlock-free private-buffer commit path: lock-free snapshot
    /// read + build + flush, with only the short manifest commit-point
    /// serialized. Many of these may run in parallel (the server holds a SHARED
    /// `read()` lock for them). Returns `GraphError::ConflictedCommit` on a
    /// write-write conflict (caller retries with a fresh snapshot).
    ///
    /// Disk-backed only — ephemeral engines must use the serial `&mut self`
    /// `commit_batch_ext` (see `store.supports_concurrent_commit()`).
    pub fn commit_batch_concurrent(
        &self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
        protected_types: &[String],
    ) -> Result<CommitDelta> {
        self.store.commit_batch_private(
            nodes,
            edges,
            changed_files,
            tags,
            &self.manifest,
            protected_types,
        )
    }

    /// Whether this engine can take the concurrent commit path (disk-backed).
    pub fn supports_concurrent_commit(&self) -> bool {
        self.store.supports_concurrent_commit()
    }

    /// MVCC C3.a: is bulk-load mode currently armed? While bulk-load is active
    /// the server routes `CommitBatch` through the serial `&mut self`
    /// (`commit_batch_ext`) path so per-commit auto-compaction can bound the
    /// live segment count — the concurrent `&self` path cannot auto-compact
    /// (compaction mutates live shard state in place, no interior locks).
    pub fn bulk_load_active(&self) -> bool {
        self.bulk_load_active
    }

    /// MVCC B4: count of conflict-driven commit retries (diagnostics / tests).
    pub fn commit_conflict_retries(&self) -> u64 {
        self.store.commit_conflict_retries()
    }

    /// MVCC B4: peak simultaneous occupancy of the LOCK-FREE commit build/flush
    /// region — the rigorous parallelism witness (`> 1` ⇒ real overlap that the
    /// 2PL path could not produce). Diagnostics / the B4 acceptance test.
    pub fn commit_build_peak(&self) -> u64 {
        self.store.commit_build_peak()
    }

    /// MVCC C1: mean group-commit batch size (commits folded per durable
    /// `commit_edit`). `> 1.0` ⇒ fsync amortization is firing. Diagnostics / the
    /// C1 acceptance test.
    pub fn group_commit_batch_size(&self) -> f64 {
        self.store.group_commit_batch_size()
    }

    /// MVCC C1: number of group-commit batches (leader publishes) so far.
    pub fn group_commit_batches(&self) -> u64 {
        self.store.group_commit_batches()
    }

    /// MVCC C1: peak single-batch fan-in (largest batch a leader drained).
    pub fn group_commit_batch_size_max(&self) -> u64 {
        self.store.group_commit_batch_size_max()
    }

    /// Compact with statistics returned (for benchmarks and diagnostics).
    ///
    /// Unlike `GraphStore::compact()` which returns `Result<()>`, this method
    /// exposes the full `CompactionResult` including nodes_merged, edges_merged,
    /// tombstones_removed, and duration_ms.
    pub fn compact_with_stats(&mut self) -> Result<CompactionResult> {
        // Flush write buffers to L0 first (same reason as compact()).
        self.flush()?;
        let config = CompactionConfig { segment_threshold: 1 };
        let result = self.store.compact(self.manifest.get_mut().unwrap(), &config)?;
        Ok(result)
    }

    /// Tag an existing snapshot.
    pub fn tag_snapshot(
        &mut self,
        version: u64,
        tags: HashMap<String, String>,
    ) -> Result<()> {
        self.manifest.get_mut().unwrap().tag_snapshot(version, tags)
    }

    /// Find a snapshot by tag key/value.
    pub fn find_snapshot(&self, tag_key: &str, tag_value: &str) -> Option<u64> {
        self.manifest.lock().unwrap().find_snapshot(tag_key, tag_value)
    }

    /// List snapshots, optionally filtered by tag key.
    pub fn list_snapshots(&self, filter_tag: Option<&str>) -> Vec<SnapshotInfo> {
        self.manifest.lock().unwrap().list_snapshots(filter_tag)
    }

    /// Diff two snapshots.
    pub fn diff_snapshots(
        &self,
        from_version: u64,
        to_version: u64,
    ) -> Result<SnapshotDiff> {
        self.manifest.lock().unwrap().diff_snapshots(from_version, to_version)
    }

    /// Whether this engine is ephemeral (in-memory only).
    pub fn is_ephemeral(&self) -> bool {
        self.ephemeral
    }

    // ── Private helpers ──────────────────────────────────────────────

    /// Auto-flush write buffers if adaptive limits or memory pressure exceeded.
    ///
    /// Probes system resources to determine thresholds. Flushes all shards
    /// if any shard's buffer exceeds the adaptive node count or byte limit.
    /// Under high memory pressure (>80%), also flushes if the buffer has at
    /// least 1000 nodes (avoids flushing trivially small batches).
    ///
    /// Errors are logged but do not propagate (write path must not fail).
    fn maybe_auto_flush(&mut self) {
        use std::time::Duration;

        // Rate-limit resource re-detection to at most once per second.
        // Between checks we use the cached TuningProfile, which is stale
        // by at most 1 s — acceptable for adaptive buffer limits and
        // memory-pressure decisions.
        if self.last_resource_check.elapsed() > Duration::from_secs(1) {
            let resources = SystemResources::detect();
            self.cached_profile = TuningProfile::from_resources(&resources);
            self.last_resource_check = Instant::now();
        }

        // Check if any shard's buffer exceeds the adaptive limits.
        let exceeds_limits = self.store.any_shard_needs_flush(
            self.cached_profile.write_buffer_node_limit,
            self.cached_profile.write_buffer_byte_limit,
        );

        // Under high memory pressure, flush earlier but only if buffer
        // has meaningful data (>= 500 nodes). Flushing 2 nodes is not
        // worth the I/O cost even under pressure.
        // Thresholds lowered from 0.8/1000 to 0.7/500 to flush earlier
        // on memory-constrained VMs (16GB with 4M+ node graphs).
        let pressure_flush = self.cached_profile.memory_pressure > 0.7
            && self.store.total_write_buffer_nodes() >= 500;

        if exceeds_limits || pressure_flush {
            if let Err(e) = self.store.flush_all(self.manifest.get_mut().unwrap()) {
                tracing::warn!("auto-flush failed: {}", e);
            }
        }
    }

    /// Auto-flush for edge-only write paths.
    ///
    /// Checks the byte limit only — never the memory-pressure path. This avoids
    /// the RFD-67 bug: if the pressure path ran here, an enricher's first addEdges
    /// call would flush all analysis-phase nodes (which are still in the write buffer)
    /// while holding the exclusive write lock, blocking reads for seconds.
    ///
    /// Edges are small (≈98 bytes each). The byte limit (100MB default) acts as a
    /// genuine OOM safeguard. Callers that want guaranteed durability should call
    /// flush() or compact() explicitly.
    fn maybe_auto_flush_edges(&mut self) {
        if self.store.any_shard_needs_flush(usize::MAX, self.cached_profile.write_buffer_byte_limit) {
            if let Err(e) = self.store.flush_all(self.manifest.get_mut().unwrap()) {
                tracing::warn!("auto-flush (edges) failed: {}", e);
            }
        }
    }

    /// Get incoming neighbors (src nodes of incoming edges).
    fn reverse_neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128> {
        // B2: version-pinned read through the published snapshot.
        let snap = self.snapshot();
        let edge_types_opt = if edge_types.is_empty() { None } else { Some(edge_types) };
        self.store.get_incoming_edges_at(&snap, id, edge_types_opt)
            .into_iter()
            .filter(|e| self.store.node_exists_at(&snap, e.src))
            .map(|e| e.src)
            .collect()
    }

    /// Internal neighbors helper (same as GraphStore::neighbors but
    /// callable without trait dispatch, avoids borrow issues).
    fn neighbors_internal(&self, id: u128, edge_types: &[&str]) -> Vec<u128> {
        // B2: version-pinned read through the published snapshot.
        let snap = self.snapshot();
        let edge_types_opt = if edge_types.is_empty() { None } else { Some(edge_types) };
        self.store.get_outgoing_edges_at(&snap, id, edge_types_opt)
            .into_iter()
            .filter(|e| self.store.node_exists_at(&snap, e.dst))
            .map(|e| e.dst)
            .collect()
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::FieldType;

    // ── Helpers ──────────────────────────────────────────────────────

    fn make_v2_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2 {
        let hash = blake3::hash(semantic_id.as_bytes());
        let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
        NodeRecordV2 {
            semantic_id: semantic_id.to_string(),
            id,
            node_type: node_type.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: String::new(),
        }
    }

    fn make_v1_node(id: u128, node_type: &str, name: &str, file: &str) -> NodeRecord {
        NodeRecord {
            id,
            node_type: Some(node_type.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(name.to_string()),
            file: Some(file.to_string()),
            metadata: None,
            semantic_id: None,
        }
    }

    fn assert_json_eq(actual: &str, expected: &str) {
        let actual: serde_json::Value =
            serde_json::from_str(actual).expect("actual must be valid JSON");
        let expected: serde_json::Value =
            serde_json::from_str(expected).expect("expected must be valid JSON");
        assert_eq!(actual, expected);
    }

    // ── Conversion Tests ─────────────────────────────────────────────

    #[test]
    fn test_node_record_v2_to_v1_roundtrip() {
        let v2 = NodeRecordV2 {
            semantic_id: "FUNCTION:foo@src/main.js".to_string(),
            id: 42,
            node_type: "FUNCTION".to_string(),
            name: "foo".to_string(),
            file: "src/main.js".to_string(),
            content_hash: 123,
            metadata: r#"{"async":true}"#.to_string(),
        };

        let v1 = node_v2_to_v1(&v2);
        assert_eq!(v1.id, 42);
        assert_eq!(v1.node_type, Some("FUNCTION".to_string()));
        assert_eq!(v1.name, Some("foo".to_string()));
        assert_eq!(v1.file, Some("src/main.js".to_string()));
        assert_eq!(v1.metadata, Some(r#"{"async":true}"#.to_string()));
        assert_eq!(v1.version, "main");
        assert!(!v1.exported);
        assert!(!v1.deleted);

        // Back to v2
        let back = node_v1_to_v2(&v1);
        assert_eq!(back.id, 42);
        assert_eq!(back.node_type, "FUNCTION");
        assert_eq!(back.name, "foo");
        assert_eq!(back.file, "src/main.js");
        assert_eq!(back.metadata, r#"{"async":true}"#);
    }

    #[test]
    fn test_node_record_v1_to_v2_conversion() {
        let v1 = NodeRecord {
            id: 99,
            node_type: None,
            file_id: 5,
            name_offset: 10,
            version: "main".to_string(),
            exported: true,
            replaces: Some(50),
            deleted: false,
            name: None,
            file: None,
            metadata: None,
            semantic_id: None,
        };

        let v2 = node_v1_to_v2(&v1);
        assert_eq!(v2.id, 99);
        assert_eq!(v2.node_type, "UNKNOWN");
        assert_eq!(v2.name, "");
        assert_eq!(v2.file, "");
        // exported=true is stored in metadata as __exported
        assert_eq!(v2.metadata, r#"{"__exported":true}"#);
        assert_eq!(v2.semantic_id, "UNKNOWN:@");
        assert_eq!(v2.content_hash, 0);

        // Roundtrip: v1 -> v2 -> v1 preserves exported
        let back = node_v2_to_v1(&v2);
        assert!(back.exported, "exported should survive v1->v2->v1 roundtrip");
        assert_eq!(back.metadata, None, "__exported should be stripped from metadata");
    }

    #[test]
    fn test_edge_record_v2_to_v1_roundtrip() {
        let v2 = EdgeRecordV2 {
            src: 1,
            dst: 2,
            edge_type: "CALLS".to_string(),
            metadata: r#"{"argIndex":0}"#.to_string(),
        };

        let v1 = edge_v2_to_v1(&v2);
        assert_eq!(v1.src, 1);
        assert_eq!(v1.dst, 2);
        assert_eq!(v1.edge_type, Some("CALLS".to_string()));
        assert_eq!(v1.metadata, Some(r#"{"argIndex":0}"#.to_string()));
        assert!(!v1.deleted);

        let back = edge_v1_to_v2(&v1);
        assert_eq!(back.src, 1);
        assert_eq!(back.dst, 2);
        assert_eq!(back.edge_type, "CALLS");
        assert_eq!(back.metadata, r#"{"argIndex":0}"#);
    }

    // ── Engine Lifecycle Tests ────────────────────────────────────────

    #[test]
    fn test_create_ephemeral() {
        let engine = GraphEngineV2::create_ephemeral();
        assert!(engine.is_ephemeral());
        assert_eq!(engine.node_count(), 0);
        assert_eq!(engine.edge_count(), 0);
    }

    #[test]
    fn test_add_get_node() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let node = make_v1_node(100, "FUNCTION", "foo", "src/main.js");

        engine.add_nodes(vec![node]);
        // B2 (RFD-71): reads see only published data — flush the staged add.
        engine.flush().unwrap();

        assert!(engine.node_exists(100));
        let retrieved = engine.get_node(100).unwrap();
        assert_eq!(retrieved.id, 100);
        assert_eq!(retrieved.node_type, Some("FUNCTION".to_string()));
        assert_eq!(retrieved.name, Some("foo".to_string()));
        assert_eq!(retrieved.file, Some("src/main.js".to_string()));
    }

    #[test]
    fn test_delete_node_buffered() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let node = make_v1_node(200, "CLASS", "Bar", "src/bar.js");
        engine.add_nodes(vec![node]);
        // B2 (RFD-71): publish the add before reading it back.
        engine.flush().unwrap();

        assert!(engine.node_exists(200));
        engine.delete_node(200);
        // B2 (RFD-71): a delete is invisible until flushed — publish the tombstone.
        engine.flush().unwrap();
        assert!(!engine.node_exists(200));
        assert!(engine.get_node(200).is_none());
    }

    #[test]
    fn test_find_by_type() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(1, "FUNCTION", "a", "src/a.js"),
            make_v1_node(2, "FUNCTION", "b", "src/b.js"),
            make_v1_node(3, "CLASS", "C", "src/c.js"),
        ]);
        // B2 (RFD-71): reads see only published data — flush the staged adds.
        engine.flush().unwrap();

        let funcs = engine.find_by_type("FUNCTION");
        assert_eq!(funcs.len(), 2);
        assert!(funcs.contains(&1));
        assert!(funcs.contains(&2));

        let classes = engine.find_by_type("CLASS");
        assert_eq!(classes.len(), 1);
        assert!(classes.contains(&3));
    }

    #[test]
    fn test_find_by_type_wildcard() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(10, "http:request", "req1", "src/a.js"),
            make_v1_node(11, "http:endpoint", "ep1", "src/b.js"),
            make_v1_node(12, "db:query", "q1", "src/c.js"),
        ]);
        // B2 (RFD-71): reads see only published data — flush the staged adds.
        engine.flush().unwrap();

        let http_nodes = engine.find_by_type("http:*");
        assert_eq!(http_nodes.len(), 2);
        assert!(http_nodes.contains(&10));
        assert!(http_nodes.contains(&11));
    }

    #[test]
    fn test_find_by_attr() {
        let mut engine = GraphEngineV2::create_ephemeral();

        let mut node = make_v1_node(20, "FUNCTION", "handler", "src/routes.js");
        node.metadata = Some(r#"{"async":true}"#.to_string());
        node.exported = true;
        engine.add_nodes(vec![
            node,
            make_v1_node(21, "FUNCTION", "helper", "src/utils.js"),
        ]);
        // B2 (RFD-71): reads see only published data — flush the staged adds.
        engine.flush().unwrap();

        // Find by name
        let query = AttrQuery::new().name("handler");
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&20));

        // Find by type + name
        let query = AttrQuery::new().node_type("FUNCTION").name("helper");
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&21));

        // Find by metadata filter
        let query = AttrQuery::new().metadata_filter("async", "true");
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&20));

        // Find by exported=true (stored as __exported in v2 metadata)
        let query = AttrQuery::new().exported(true);
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&20));

        // Find by exported=false
        let query = AttrQuery::new().exported(false);
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&21));

        // Version is ignored in v2 (snapshot-level history, no per-node version column)
        let query = AttrQuery::new().version("dev").name("helper");
        let result = engine.find_by_attr(&query);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&21));
    }

    #[test]
    fn test_add_get_edges() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(30, "FUNCTION", "caller", "src/a.js"),
            make_v1_node(31, "FUNCTION", "callee", "src/a.js"),
        ]);

        let edge = EdgeRecord {
            src: 30,
            dst: 31,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        };
        engine.add_edges(vec![edge], false);
        // B2 (RFD-71): reads see only published data — flush the staged add+edge.
        engine.flush().unwrap();

        let outgoing = engine.get_outgoing_edges(30, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].src, 30);
        assert_eq!(outgoing[0].dst, 31);
        assert_eq!(outgoing[0].edge_type, Some("CALLS".to_string()));

        let incoming = engine.get_incoming_edges(31, None);
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].src, 30);
    }

    /// `sim_datalog_v2` (the engine seam for what-if) predicts the derived facts a hypothetical
    /// edit would create, WITHOUT committing it. Base graph: two MODULEs (a.ts / b.ts) + one
    /// existing function in b.ts, NO import binding in a.ts → depends/2 is empty. sim adds a
    /// wholly NEW import binding in a.ts (hypothetical node) importing the b.ts function
    /// (hypothetical edge), and must predict `depends(m_a, m_b)` while leaving the committed
    /// graph untouched — exercising both hypothetical-node and hypothetical-edge overlay.
    #[test]
    fn sim_datalog_v2_predicts_new_depends_without_committing() {
        use crate::datalog::EvalLimits;
        let src = crate::datalog2::stdlib::DEPENDS_DL;

        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(1, "MODULE", "m_a", "a.ts"),
            make_v1_node(2, "MODULE", "m_b", "b.ts"),
            make_v1_node(20, "FUNCTION", "eb", "b.ts"),
        ]);
        engine.flush().unwrap();

        // Base world: no import binding in a.ts → no module dependency.
        let base = engine.eval_datalog_v2(src, "depends", EvalLimits::none()).expect("base eval");
        assert!(base.is_empty(), "no IMPORTS_FROM yet → depends is empty, got {base:?}");

        // sim: what if a NEW import binding in a.ts imported eb (b.ts)? → depends(m_a, m_b).
        let added = engine
            .sim_datalog_v2(
                src,
                "depends",
                &[(99u128, "IMPORT_BINDING".to_string(), "hypo_import".to_string(), "a.ts".to_string())],
                &[(99u128, 20u128, "IMPORTS_FROM".to_string())],
                EvalLimits::none(),
            )
            .expect("sim eval");
        assert_eq!(
            added,
            vec![vec!["1".to_string(), "2".to_string()]],
            "sim predicts exactly the new depends(m_a=1, m_b=2) the hypothetical import would create"
        );

        // NON-DESTRUCTIVE: the committed graph still has neither the hypothetical node nor edge.
        let after = engine.eval_datalog_v2(src, "depends", EvalLimits::none()).expect("re-eval");
        assert!(after.is_empty(), "sim must NOT commit the hypothetical edit; got {after:?}");
        assert!(!engine.node_exists(99), "the hypothetical node must never reach the committed store");
    }

    /// `explain_datalog_gap` (engine why-NOT) names the unbound premise of a missing fact — the
    /// companion to `sim_datalog_v2`. Program: `calls_someone(F) :- node(F,"FUNCTION"),
    /// edge(F,_,"CALLS")`. f1 calls f2 (so it holds); f3 is a FUNCTION calling nothing, so the
    /// gap is exactly the missing CALLS edge.
    #[test]
    fn explain_datalog_gap_names_missing_premise_through_engine() {
        use crate::datalog::{EvalLimits, Value};
        let src = "calls_someone(F) :- node(F, \"FUNCTION\"), edge(F, X, \"CALLS\").";

        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(1, "FUNCTION", "f1", "a.ts"),
            make_v1_node(2, "FUNCTION", "f2", "a.ts"),
            make_v1_node(3, "FUNCTION", "f3", "a.ts"),
        ]);
        engine.add_edges(
            vec![EdgeRecord {
                src: 1,
                dst: 2,
                edge_type: Some("CALLS".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            false,
        );
        engine.flush().unwrap();

        // f3 is a FUNCTION but calls nobody → calls_someone(f3) gaps at the CALLS edge premise.
        let gap = engine
            .explain_datalog_gap(src, "calls_someone", &[Value::Id(3)], EvalLimits::none())
            .expect("no error")
            .expect("calls_someone(f3) is NOT derivable → a gap");
        assert_eq!(gap.failing_predicate, "edge", "the unbound premise is the CALLS edge");
        assert!(!gap.failing_is_negative, "a MISSING positive premise (closes by adding)");

        // f1 DOES call someone → no gap.
        let none = engine
            .explain_datalog_gap(src, "calls_someone", &[Value::Id(1)], EvalLimits::none())
            .expect("no error");
        assert!(none.is_none(), "calls_someone(f1) is derivable → no gap");
    }

    #[test]
    fn test_neighbors() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(40, "FUNCTION", "a", "src/a.js"),
            make_v1_node(41, "FUNCTION", "b", "src/a.js"),
            make_v1_node(42, "FUNCTION", "c", "src/a.js"),
        ]);
        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 40, dst: 41,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 40, dst: 42,
                    edge_type: Some("IMPORTS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
            ],
            false,
        );
        // B2 (RFD-71): reads see only published data — flush the staged adds.
        engine.flush().unwrap();

        // All neighbors
        let all = engine.neighbors(40, &[]);
        assert_eq!(all.len(), 2);

        // Filter by edge type
        let calls_only = engine.neighbors(40, &["CALLS"]);
        assert_eq!(calls_only.len(), 1);
        assert!(calls_only.contains(&41));
    }

    #[test]
    fn test_bfs_traversal() {
        let mut engine = GraphEngineV2::create_ephemeral();
        // Graph: 50 -> 51 -> 52 -> 53
        engine.add_nodes(vec![
            make_v1_node(50, "FUNCTION", "a", "src/a.js"),
            make_v1_node(51, "FUNCTION", "b", "src/a.js"),
            make_v1_node(52, "FUNCTION", "c", "src/a.js"),
            make_v1_node(53, "FUNCTION", "d", "src/a.js"),
        ]);
        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 50, dst: 51,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 51, dst: 52,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 52, dst: 53,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
            ],
            false,
        );
        // B2 (RFD-71): reads see only published data — flush the staged adds.
        engine.flush().unwrap();

        // Full BFS
        let result = engine.bfs(&[50], 10, &["CALLS"]);
        assert_eq!(result.len(), 4);

        // Depth-limited BFS
        let result = engine.bfs(&[50], 2, &["CALLS"]);
        assert_eq!(result.len(), 3); // 50, 51, 52
        assert!(!result.contains(&53));
    }

    #[test]
    fn test_flush_persists_tombstones() {
        let mut engine = GraphEngineV2::create_ephemeral();

        // Use proper blake3-derived IDs (flush writes to segments which
        // assert id == blake3(semantic_id))
        let live = make_v2_node("FUNCTION:live@src/a.js", "FUNCTION", "live", "src/a.js");
        let dead = make_v2_node("FUNCTION:dead@src/a.js", "FUNCTION", "dead", "src/a.js");
        let live_id = live.id;
        let dead_id = dead.id;

        engine.store.add_nodes(vec![live, dead]);

        engine.delete_node(dead_id);

        // B2 (RFD-71): the delete is invisible to reads until flushed — publish
        // it, then both the tombstone and the surviving node are observable.
        engine.flush().unwrap();
        assert!(!engine.node_exists(dead_id));
        assert!(engine.node_exists(live_id));

        // Flush clears pending tombstones
        assert!(engine.pending_tombstone_nodes.is_empty());
        assert!(engine.pending_tombstone_edges.is_empty());
    }

    #[test]
    fn test_commit_batch_v2() {
        let mut engine = GraphEngineV2::create_ephemeral();

        let node = make_v2_node("FUNCTION:init@src/app.js", "FUNCTION", "init", "src/app.js");
        let node_id = node.id;

        let delta = engine
            .commit_batch(
                vec![node],
                vec![],
                &["src/app.js".to_string()],
                HashMap::from([("version".to_string(), "v1".to_string())]),
            )
            .unwrap();

        assert_eq!(delta.changed_files, vec!["src/app.js"]);
        assert!(delta.nodes_added > 0 || delta.nodes_modified == 0);
        assert!(engine.node_exists(node_id));
    }

    /// Re-analysis of a file (80 nodes → 30 same-id nodes) must report 30 live
    /// nodes, not 60. The 50 dropped ids are tombstoned; the 30 re-added ids
    /// live in BOTH the old flushed segment and the new segment, so a naive
    /// "sum of segment record counts" double-counts them.
    fn count_re_added_setup() -> (GraphEngineV2, Vec<u128>) {
        let mut engine = GraphEngineV2::create_ephemeral();
        let file = "src/big.js";

        // First analysis: 80 FUNCTION nodes for the file.
        let mut nodes_v1 = Vec::with_capacity(80);
        let mut ids = Vec::with_capacity(80);
        for i in 0..80u32 {
            let n = make_v2_node(
                &format!("FUNCTION:f{i}@{file}"),
                "FUNCTION",
                &format!("f{i}"),
                file,
            );
            ids.push(n.id);
            nodes_v1.push(n);
        }
        engine
            .commit_batch(nodes_v1, vec![], &[file.to_string()], HashMap::new())
            .unwrap();
        assert_eq!(engine.node_count(), 80, "after first commit");

        // Re-analysis: same file, only the first 30 ids survive (different
        // content), the other 50 are dropped → tombstoned.
        let mut nodes_v2 = Vec::with_capacity(30);
        for i in 0..30u32 {
            let mut n = make_v2_node(
                &format!("FUNCTION:f{i}@{file}"),
                "FUNCTION",
                &format!("f{i}"),
                file,
            );
            n.content_hash = (i as u64) + 1; // different content
            assert_eq!(n.id, ids[i as usize], "same semantic_id → same id");
            nodes_v2.push(n);
        }
        engine
            .commit_batch(nodes_v2, vec![], &[file.to_string()], HashMap::new())
            .unwrap();

        (engine, ids)
    }

    #[test]
    fn test_node_count_excludes_tombstoned_and_re_added_duplicates() {
        let (engine, ids) = count_re_added_setup();

        // 30 live, 50 tombstoned. Per-id liveness is already correct.
        for (i, id) in ids.iter().enumerate() {
            if i < 30 {
                assert!(engine.node_exists(*id), "f{i} should be live");
            } else {
                assert!(!engine.node_exists(*id), "f{i} should be tombstoned");
            }
        }

        // The aggregate counter must match per-id liveness.
        assert_eq!(
            engine.node_count(),
            30,
            "node_count must report 30 live nodes (not double-count re-added ids)"
        );

        // count_by_type must be consistent with node_count.
        let by_type = engine.count_nodes_by_type(None);
        let total: usize = by_type.values().sum();
        assert_eq!(total, 30, "count_by_type total must equal node_count");
        assert_eq!(by_type.get("FUNCTION").copied(), Some(30));
    }

    #[test]
    fn test_node_count_after_delete_via_commit_and_reopen() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("recount.rfdb");
        let file = "src/big.js";
        let kept: Vec<u128>;

        {
            let mut engine = GraphEngineV2::create(&db_path).unwrap();
            let mut nodes_v1 = Vec::with_capacity(80);
            for i in 0..80u32 {
                nodes_v1.push(make_v2_node(
                    &format!("FUNCTION:f{i}@{file}"),
                    "FUNCTION",
                    &format!("f{i}"),
                    file,
                ));
            }
            engine
                .commit_batch(nodes_v1, vec![], &[file.to_string()], HashMap::new())
                .unwrap();

            let mut nodes_v2 = Vec::with_capacity(30);
            let mut k = Vec::with_capacity(30);
            for i in 0..30u32 {
                let mut n = make_v2_node(
                    &format!("FUNCTION:f{i}@{file}"),
                    "FUNCTION",
                    &format!("f{i}"),
                    file,
                );
                n.content_hash = (i as u64) + 1;
                k.push(n.id);
                nodes_v2.push(n);
            }
            kept = k;
            engine
                .commit_batch(nodes_v2, vec![], &[file.to_string()], HashMap::new())
                .unwrap();
            engine.flush().unwrap();
            assert_eq!(engine.node_count(), 30, "before reopen");
        }

        // Reopen from disk: tombstones come from the manifest, not pending sets.
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert_eq!(engine.node_count(), 30, "after reopen");
        for id in &kept {
            assert!(engine.node_exists(*id));
        }
        let by_type = engine.count_nodes_by_type(None);
        assert_eq!(by_type.values().sum::<usize>(), 30, "by_type after reopen");
    }

    /// MVCC B3 acceptance #1 — per-version tombstone isolation.
    ///
    /// A snapshot captured at version V freezes V's cumulative tombstone set
    /// (now sourced from the manifest VERSION, not a per-shard broadcast). A
    /// later commit that tombstones a node changes the LIVE version's visible
    /// set but MUST NOT change the already-captured old snapshot — and a fresh
    /// snapshot MUST see the new tombstone. This is the property B4 concurrency
    /// depends on (tombstones immutable-per-version, no shared-mutable race).
    #[test]
    fn test_b3_version_tombstone_isolation() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let file = "src/iso.js";

        let keep = make_v2_node("FUNCTION:keep@src/iso.js", "FUNCTION", "keep", file);
        let doomed = make_v2_node("FUNCTION:doomed@src/iso.js", "FUNCTION", "doomed", file);
        let keep_id = keep.id;
        let doomed_id = doomed.id;

        // Commit 1: both nodes live.
        engine
            .commit_batch(vec![keep, doomed], vec![], &[file.to_string()], HashMap::new())
            .unwrap();

        // Pin a snapshot of version V1 (both nodes present, none tombstoned).
        let snap_v1 = engine.store.snapshot(&engine.manifest.lock().unwrap());
        assert!(engine.store.node_exists_at(&snap_v1, doomed_id), "V1 sees doomed");
        assert!(engine.store.node_exists_at(&snap_v1, keep_id), "V1 sees keep");
        assert!(
            !snap_v1.tombstones.contains_node(doomed_id),
            "V1 snapshot tombstone set is empty for doomed"
        );

        // Commit 2: re-analyze the file dropping `doomed` (tombstoned), keeping `keep`.
        let keep_v2 = make_v2_node("FUNCTION:keep@src/iso.js", "FUNCTION", "keep", file);
        engine
            .commit_batch(vec![keep_v2], vec![], &[file.to_string()], HashMap::new())
            .unwrap();

        // OLD snapshot is frozen: still sees `doomed` (tombstoned only in V2).
        assert!(
            engine.store.node_exists_at(&snap_v1, doomed_id),
            "old snapshot must STILL see doomed — version-pinned tombstones"
        );
        assert!(
            !snap_v1.tombstones.contains_node(doomed_id),
            "old snapshot's frozen tombstone Arc must be unaffected by V2"
        );

        // FRESH snapshot sees the new version: `doomed` is tombstoned.
        let snap_v2 = engine.store.snapshot(&engine.manifest.lock().unwrap());
        assert!(snap_v2.version > snap_v1.version, "V2 is a later version");
        assert!(
            snap_v2.tombstones.contains_node(doomed_id),
            "fresh snapshot's tombstone set (from the manifest version) includes doomed"
        );
        assert!(
            !engine.store.node_exists_at(&snap_v2, doomed_id),
            "fresh snapshot must NOT see tombstoned doomed"
        );
        assert!(engine.store.node_exists_at(&snap_v2, keep_id), "keep survives in V2");

        // Live engine reads (newest version) agree.
        assert!(!engine.node_exists(doomed_id), "live read: doomed gone");
        assert!(engine.node_exists(keep_id), "live read: keep present");
    }

    /// MVCC B3 acceptance #2 — reopen fidelity through the flush() delete path.
    ///
    /// `delete_node` + `flush()` (not `commit_batch`) is a deletion path that
    /// previously persisted tombstones only to the per-shard set. B3 routes the
    /// deletion into the manifest VERSION (the authority), so the delete is on
    /// disk and survives reopen — verified here against a SECOND delete in the
    /// same session (the replace-not-merge shard mirror would otherwise drop the
    /// first delete).
    #[test]
    fn test_b3_delete_via_flush_survives_reopen() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("flush_del.rfdb");

        let a = make_v2_node("FUNCTION:a@src/f.js", "FUNCTION", "a", "src/f.js");
        let b = make_v2_node("FUNCTION:b@src/f.js", "FUNCTION", "b", "src/f.js");
        let c = make_v2_node("FUNCTION:c@src/f.js", "FUNCTION", "c", "src/f.js");
        let a_id = a.id;
        let b_id = b.id;
        let c_id = c.id;

        {
            let mut engine = GraphEngineV2::create(&db_path).unwrap();
            engine
                .commit_batch(
                    vec![a, b, c],
                    vec![],
                    &["src/f.js".to_string()],
                    HashMap::new(),
                )
                .unwrap();
            assert_eq!(engine.node_count(), 3);

            // Two separate delete+flush cycles. Each flush merges the deletion
            // into the manifest version (not a replace), so BOTH survive.
            engine.delete_node(a_id);
            engine.flush().unwrap();
            assert!(!engine.node_exists(a_id), "a deleted after first flush");

            engine.delete_node(b_id);
            engine.flush().unwrap();
            assert!(!engine.node_exists(b_id), "b deleted after second flush");
            assert!(!engine.node_exists(a_id), "a STILL deleted after second flush");
            assert!(engine.node_exists(c_id), "c survives");
            assert_eq!(engine.node_count(), 1, "only c live before reopen");
        }

        // Reopen: tombstones come from the manifest version, deletes stay deleted.
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert!(!engine.node_exists(a_id), "a stays deleted after reopen");
        assert!(!engine.node_exists(b_id), "b stays deleted after reopen");
        assert!(engine.node_exists(c_id), "c stays live after reopen");
        assert_eq!(engine.node_count(), 1, "only c live after reopen");
    }

    #[test]
    fn test_edge_count_excludes_tombstoned_and_re_added_duplicates() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let file = "src/e.js";

        // Two endpoint nodes that always survive (separate file, untouched).
        let a = make_v2_node("FUNCTION:a@src/lib.js", "FUNCTION", "a", "src/lib.js");
        let b = make_v2_node("FUNCTION:b@src/lib.js", "FUNCTION", "b", "src/lib.js");
        engine
            .commit_batch(
                vec![a.clone(), b.clone()],
                vec![],
                &["src/lib.js".to_string()],
                HashMap::new(),
            )
            .unwrap();

        // First analysis of file e.js: source node s with 4 CALLS edges to a.
        let s = make_v2_node("FUNCTION:s@src/e.js", "FUNCTION", "s", file);
        let mk_edge = |src: u128, dst: u128, idx: u32| EdgeRecordV2 {
            src,
            dst,
            edge_type: "CALLS".to_string(),
            metadata: format!("{{\"i\":{idx}}}"),
        };
        engine
            .commit_batch(
                vec![s.clone()],
                vec![mk_edge(s.id, a.id, 0), mk_edge(s.id, b.id, 1)],
                &[file.to_string()],
                HashMap::new(),
            )
            .unwrap();
        assert_eq!(engine.edge_count(), 2, "after first edge commit");

        // Re-analysis: same source node, only ONE of the two edges remains
        // (s→a re-emitted, s→b dropped).
        engine
            .commit_batch(
                vec![s.clone()],
                vec![mk_edge(s.id, a.id, 0)],
                &[file.to_string()],
                HashMap::new(),
            )
            .unwrap();

        assert_eq!(
            engine.get_outgoing_edges(s.id, None).len(),
            1,
            "only s->a should be live"
        );
        assert_eq!(
            engine.edge_count(),
            1,
            "edge_count must report 1 live edge (not double-count re-added edge)"
        );
    }

    #[test]
    fn test_v1_v2_equivalence() {
        // Verify that adding a v1 node and retrieving it produces
        // consistent data after v1->v2->v1 conversion
        let mut engine = GraphEngineV2::create_ephemeral();

        let original = NodeRecord {
            id: 999,
            node_type: Some("METHOD".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("process".to_string()),
            file: Some("src/worker.js".to_string()),
            metadata: Some(r#"{"line":42}"#.to_string()),
            semantic_id: None,
        };

        engine.add_nodes(vec![original.clone()]);
        // B2 (RFD-71): reads see only published data — flush the staged add.
        engine.flush().unwrap();
        let retrieved = engine.get_node(999).unwrap();

        // Core fields must match
        assert_eq!(retrieved.id, original.id);
        assert_eq!(retrieved.node_type, original.node_type);
        assert_eq!(retrieved.name, original.name);
        assert_eq!(retrieved.file, original.file);
        assert_eq!(retrieved.metadata, original.metadata);

        // Identifier format
        let ident = engine.get_node_identifier(999).unwrap();
        assert_eq!(ident, "METHOD:process@src/worker.js");
    }

    #[test]
    fn test_disk_roundtrip_preserves_node_and_edge_metadata() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");

        let source = NodeRecord {
            id: 10,
            node_type: Some("FUNCTION".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: true,
            replaces: None,
            deleted: false,
            name: Some("compute".to_string()),
            file: Some("src/a.js".to_string()),
            metadata: Some(r#"{"line":10,"lang":"js"}"#.to_string()),
            semantic_id: None,
        };
        let target = NodeRecord {
            id: 11,
            node_type: Some("FUNCTION".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("target".to_string()),
            file: Some("src/b.js".to_string()),
            metadata: Some(r#"{"line":20}"#.to_string()),
            semantic_id: None,
        };
        let edge = EdgeRecord {
            src: source.id,
            dst: target.id,
            edge_type: Some("FLOWS_INTO".to_string()),
            version: "main".to_string(),
            metadata: Some(r#"{"computedPropertyVar":"k","argIndex":0}"#.to_string()),
            deleted: false,
        };

        {
            let mut engine = GraphEngineV2::create(&db_path).unwrap();
            engine.add_nodes(vec![source.clone(), target.clone()]);
            engine.add_edges(vec![edge.clone()], false);
            engine.flush().unwrap();
        }

        let engine = GraphEngineV2::open(&db_path).unwrap();
        let loaded_source = engine
            .get_node(source.id)
            .expect("source node not found after reopen");
        assert!(loaded_source.exported, "exported flag must survive roundtrip");
        let loaded_metadata = loaded_source
            .metadata
            .as_deref()
            .expect("source metadata must exist");
        assert_json_eq(
            loaded_metadata,
            source.metadata.as_deref().unwrap(),
        );

        let outgoing = engine.get_outgoing_edges(source.id, None);
        assert_eq!(outgoing.len(), 1);
        let edge_metadata = outgoing[0]
            .metadata
            .as_deref()
            .expect("edge metadata must exist");
        assert_json_eq(edge_metadata, edge.metadata.as_deref().unwrap());
    }

    // ── Extra Method Tests ───────────────────────────────────────────

    #[test]
    fn test_clear_resets_engine() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![make_v1_node(70, "FUNCTION", "x", "src/x.js")]);
        // B2 (RFD-71): reads see only published data — flush the staged add.
        engine.flush().unwrap();
        assert_eq!(engine.node_count(), 1);

        engine.clear();
        assert_eq!(engine.node_count(), 0);
        assert!(!engine.node_exists(70));
    }

    #[test]
    fn test_is_endpoint() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(80, "http:request", "req", "src/a.js"),
            make_v1_node(81, "FUNCTION", "helper", "src/a.js"),
            make_v1_node(82, "db:query", "q", "src/a.js"),
            make_v1_node(83, "EXTERNAL", "ext", "src/a.js"),
        ]);
        // B2 (RFD-71): reads see only published data — flush the staged adds.
        engine.flush().unwrap();

        assert!(engine.is_endpoint(80));  // http:request
        assert!(!engine.is_endpoint(81)); // regular FUNCTION
        assert!(engine.is_endpoint(82));  // db:query
        assert!(engine.is_endpoint(83));  // EXTERNAL
    }

    #[test]
    fn test_reachability_forward_and_backward() {
        let mut engine = GraphEngineV2::create_ephemeral();
        // Graph: 90 -> 91 -> 92
        engine.add_nodes(vec![
            make_v1_node(90, "FUNCTION", "a", "src/a.js"),
            make_v1_node(91, "FUNCTION", "b", "src/a.js"),
            make_v1_node(92, "FUNCTION", "c", "src/a.js"),
        ]);
        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 90, dst: 91,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 91, dst: 92,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
            ],
            false,
        );
        // B2 (RFD-71): reads see only published data — flush the staged adds.
        engine.flush().unwrap();

        // Forward from 90
        let fwd = engine.reachability(&[90], 10, &["CALLS"], false);
        assert_eq!(fwd.len(), 3);

        // Backward from 92
        let bwd = engine.reachability(&[92], 10, &["CALLS"], true);
        assert_eq!(bwd.len(), 3);
    }

    #[test]
    fn test_declare_fields() {
        let mut engine = GraphEngineV2::create_ephemeral();
        assert!(engine.declared_fields_ref().is_empty());

        engine.declare_fields(vec![FieldDecl {
            name: "async".to_string(),
            field_type: FieldType::Bool,
            node_types: Some(vec!["FUNCTION".to_string()]),
        }]);

        assert_eq!(engine.declared_fields_ref().len(), 1);
        assert_eq!(engine.declared_fields_ref()[0].name, "async");
    }

    #[test]
    fn test_delete_edge_tombstone() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(100, "FUNCTION", "a", "src/a.js"),
            make_v1_node(101, "FUNCTION", "b", "src/a.js"),
        ]);
        engine.add_edges(
            vec![EdgeRecord {
                src: 100, dst: 101,
                edge_type: Some("CALLS".to_string()),
                version: "main".to_string(),
                metadata: None, deleted: false,
            }],
            false,
        );
        // B2 (RFD-71): publish the staged add+edge before reading.
        engine.flush().unwrap();

        assert_eq!(engine.get_outgoing_edges(100, None).len(), 1);

        engine.delete_edge(100, 101, "CALLS");
        // B2 (RFD-71): the edge delete is invisible until flushed — publish it.
        engine.flush().unwrap();
        assert_eq!(engine.get_outgoing_edges(100, None).len(), 0);
    }

    #[test]
    fn test_readd_node_clears_pending_tombstone() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let node = make_v1_node(102, "FUNCTION", "foo", "src/a.js");

        engine.add_nodes(vec![node.clone()]);
        // B2 (RFD-71): publish the add before reading it back.
        engine.flush().unwrap();
        assert!(engine.node_exists(102));

        // Delete then re-add the same ID in the same session: the re-add must
        // clear the pending tombstone so that, once published, the node is live.
        // (Reads between the staged ops are invisible under B2, so we only
        // assert the published outcome.)
        engine.delete_node(102);
        engine.add_nodes(vec![node]);

        engine.flush().unwrap();
        assert!(engine.node_exists(102));
    }

    #[test]
    fn test_readd_edge_clears_pending_tombstone() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(103, "FUNCTION", "srcFn", "src/a.js"),
            make_v1_node(104, "FUNCTION", "dstFn", "src/a.js"),
        ]);

        let edge = EdgeRecord {
            src: 103,
            dst: 104,
            edge_type: Some("FLOWS_INTO".to_string()),
            version: "main".to_string(),
            metadata: Some(r#"{"computedPropertyVar":"key"}"#.to_string()),
            deleted: false,
        };

        engine.add_edges(vec![edge.clone()], false);
        // B2 (RFD-71): publish the staged nodes+edge before reading.
        engine.flush().unwrap();
        assert_eq!(engine.get_outgoing_edges(103, None).len(), 1);

        // Delete then re-add the same edge key in the same session: the re-add
        // must clear the pending tombstone so the published edge stays live.
        // Reads between the staged ops are invisible under B2, so we only assert
        // the published outcome.
        engine.delete_edge(103, 104, "FLOWS_INTO");
        engine.add_edges(vec![edge.clone()], false);

        engine.flush().unwrap();
        let outgoing_after_flush = engine.get_outgoing_edges(103, None);
        assert_eq!(outgoing_after_flush.len(), 1);
        assert_eq!(outgoing_after_flush[0].metadata, edge.metadata);
    }

    #[test]
    fn test_count_nodes_by_type() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(110, "FUNCTION", "a", "src/a.js"),
            make_v1_node(111, "FUNCTION", "b", "src/b.js"),
            make_v1_node(112, "CLASS", "C", "src/c.js"),
        ]);
        // B2 (RFD-71): reads see only published data — flush the staged adds.
        engine.flush().unwrap();

        let counts = engine.count_nodes_by_type(None);
        assert_eq!(counts.get("FUNCTION"), Some(&2));
        assert_eq!(counts.get("CLASS"), Some(&1));

        // Filtered
        let counts = engine.count_nodes_by_type(Some(&["FUNCTION".to_string()]));
        assert_eq!(counts.get("FUNCTION"), Some(&2));
        assert!(counts.get("CLASS").is_none());
    }

    #[test]
    fn test_get_all_edges() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(120, "FUNCTION", "a", "src/a.js"),
            make_v1_node(121, "FUNCTION", "b", "src/a.js"),
            make_v1_node(122, "FUNCTION", "c", "src/a.js"),
        ]);
        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 120, dst: 121,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
                EdgeRecord {
                    src: 121, dst: 122,
                    edge_type: Some("IMPORTS".to_string()),
                    version: "main".to_string(),
                    metadata: None, deleted: false,
                },
            ],
            false,
        );
        // B2 (RFD-71): reads see only published data — flush the staged adds.
        engine.flush().unwrap();

        let all = engine.get_all_edges();
        assert_eq!(all.len(), 2);
    }

    // ── Adaptive Shard Count ────────────────────────────────────────

    /// Regression test for RFD-67: edge writes must not block concurrent reads.
    ///
    /// Before the fix, `add_edges` called `maybe_auto_flush` which triggered
    /// `flush_all` under the exclusive write lock. This blocked reads for seconds
    /// when the write buffer had many analysis nodes (memory-pressure path).
    ///
    /// This test wraps the engine in an RwLock (mirroring the production
    /// `Database.engine` field) and verifies that read queries complete quickly
    /// while edge writes are in progress.
    #[test]
    fn test_edge_writes_do_not_block_reads() {
        use std::sync::{Arc, RwLock};
        use std::time::{Duration, Instant};

        // Build engine with many pre-loaded nodes (simulates post-analysis state).
        let mut engine = GraphEngineV2::create_ephemeral();
        for i in 0u128..600 {
            engine.add_nodes(vec![make_v1_node(i, "FUNCTION", &format!("fn_{i}"), "src/a.js")]);
        }
        // Don't flush — leave nodes in write buffer so memory-pressure path could trigger.

        let engine = Arc::new(RwLock::new(engine));

        // Writer thread: adds edges in a tight loop (simulates an enricher write storm).
        let writer_engine = Arc::clone(&engine);
        let writer = std::thread::spawn(move || {
            for i in 0u128..100 {
                let src = i % 600;
                let dst = (i + 1) % 600;
                let mut eng = writer_engine.write().unwrap();
                eng.add_edges(vec![EdgeRecord {
                    src,
                    dst,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None,
                    deleted: false,
                }], true);
            }
        });

        // Reader thread: queries nodes while the writer runs. Must not block.
        let reader_engine = Arc::clone(&engine);
        let reader = std::thread::spawn(move || {
            let start = Instant::now();
            for _ in 0..10 {
                let eng = reader_engine.read().unwrap();
                let _ = eng.find_by_type("FUNCTION");
                drop(eng);
                std::thread::sleep(Duration::from_millis(5));
            }
            start.elapsed()
        });

        writer.join().unwrap();
        let read_duration = reader.join().unwrap();

        // 10 reads × 5ms sleep = 50ms minimum. Total should be well under 500ms.
        // Before the fix, a single auto-flush could hold the write lock for
        // hundreds of milliseconds, causing reads to queue up.
        assert!(
            read_duration < Duration::from_millis(1000),
            "reads took {:?} — edge writes are blocking reads (RFD-67 regression)",
            read_duration,
        );
    }

    #[test]
    fn test_adaptive_shard_count_on_disk() {
        use crate::storage_v2::resource::ResourceManager;

        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("adaptive.rfdb");

        let engine = GraphEngineV2::create(&db_path).unwrap();
        let profile = ResourceManager::auto_tune();

        // Verify the engine's shard count matches the adaptive profile.
        // We check via node_count (engine exists) and verify profile range.
        assert!(
            profile.shard_count >= 1 && profile.shard_count <= 16,
            "shard_count {} out of expected [1, 16] range",
            profile.shard_count
        );

        // Engine should work normally with adaptive shard count.
        assert_eq!(engine.node_count(), 0);
    }

    // ── Auto-Flush ──────────────────────────────────────────────────

    #[test]
    fn test_auto_flush_triggers_on_buffer_limit() {
        // Use MultiShardStore directly to test the any_shard_needs_flush() wiring.
        // With node_limit=5, adding 5+ nodes should trigger the check.
        let mut store = MultiShardStore::ephemeral(2);

        // Add 3 nodes — should NOT exceed limit of 5
        store.add_nodes(vec![
            make_v2_node("FUNCTION:a@src/a.js", "FUNCTION", "a", "src/a.js"),
            make_v2_node("FUNCTION:b@src/a.js", "FUNCTION", "b", "src/a.js"),
            make_v2_node("FUNCTION:c@src/a.js", "FUNCTION", "c", "src/a.js"),
        ]);
        assert!(!store.any_shard_needs_flush(5, usize::MAX));

        // Add 5 more — at least one shard should exceed 5 nodes
        for i in 0..5 {
            let id = format!("FUNCTION:x{i}@src/a.js");
            store.add_nodes(vec![make_v2_node(&id, "FUNCTION", &format!("x{i}"), "src/a.js")]);
        }
        assert!(store.any_shard_needs_flush(5, usize::MAX));
    }

    #[test]
    fn test_auto_flush_byte_limit() {
        let mut store = MultiShardStore::ephemeral(1);

        // Add nodes and check estimated bytes
        for i in 0..10 {
            let id = format!("FUNCTION:n{i}@src/a.js");
            store.add_nodes(vec![make_v2_node(&id, "FUNCTION", &format!("n{i}"), "src/a.js")]);
        }

        // 10 nodes * 120 bytes = 1200 bytes. A limit of 1000 should trigger.
        assert!(store.any_shard_needs_flush(usize::MAX, 1000));
        // A limit of 2000 should not trigger.
        assert!(!store.any_shard_needs_flush(usize::MAX, 2000));
    }

    // ── flush_data_only No-op ──────────────────────────────────────

    #[test]
    fn test_flush_data_only_is_noop_v2() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("noop_flush.rfdb");

        let mut engine = GraphEngineV2::create(&db_path).unwrap();

        // Add nodes and edges using blake3-derived IDs (required for segment writes)
        let node_a = make_v2_node("FUNCTION:a@src/a.js", "FUNCTION", "a", "src/a.js");
        let node_b = make_v2_node("FUNCTION:b@src/a.js", "FUNCTION", "b", "src/a.js");
        let id_a = node_a.id;
        let id_b = node_b.id;
        engine.store.add_nodes(vec![node_a, node_b]);

        engine.add_edges(vec![EdgeRecord {
            src: id_a, dst: id_b,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None, deleted: false,
        }], false);

        // flush_data_only is a no-op below the size threshold — no segments
        // written, nothing published. Under B2 (RFD-71) the staged write buffer
        // is invisible to reads, so the data is NOT observable yet (no mid-test
        // write-buffer read — that would be a dirty read B2 forbids).
        engine.flush_data_only().unwrap();

        // Now flush() actually persists + publishes a new manifest version.
        engine.flush().unwrap();

        // Data readable after the real flush (from the published segments).
        assert!(engine.node_exists(id_a));
        assert!(engine.node_exists(id_b));
        let outgoing = engine.get_outgoing_edges(id_a, None);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].dst, id_b);
    }

    #[test]
    fn test_deferred_bulk_load_v2() {
        let mut engine = GraphEngineV2::create_ephemeral();

        // Simulate bulk load: 100 files, each with ~5 nodes
        for file_idx in 0..100 {
            let file = format!("src/file_{file_idx}.js");

            // Delete old nodes for this file (simulate re-analysis)
            let old_ids = engine.find_by_attr(
                &AttrQuery { file: Some(file.clone()), ..AttrQuery::default() },
            );
            for id in old_ids {
                engine.delete_node(id);
            }

            // Add new nodes
            let mut nodes = Vec::new();
            for node_idx in 0..5 {
                let name = format!("fn_{file_idx}_{node_idx}");
                nodes.push(make_v1_node(
                    (file_idx * 1000 + node_idx) as u128,
                    "FUNCTION",
                    &name,
                    &file,
                ));
            }
            engine.add_nodes(nodes);

            // flush_data_only is a no-op below threshold; flush() publishes.
            // B2 (RFD-71): reads see only published data, so publish before the
            // read-back.
            engine.flush_data_only().unwrap();
            engine.flush().unwrap();

            // All nodes for this file should be readable (from published segments)
            let found = engine.find_by_attr(
                &AttrQuery { file: Some(file.clone()), ..AttrQuery::default() },
            );
            assert_eq!(
                found.len(), 5,
                "file {file_idx}: expected 5 nodes, found {}",
                found.len()
            );
        }

        // Total: 100 files * 5 nodes = 500 nodes
        assert_eq!(engine.node_count(), 500);

        // rebuild_indexes (which calls flush) should persist everything
        engine.rebuild_indexes().unwrap();
        assert_eq!(engine.node_count(), 500);

        // Spot-check: random file's nodes are still there
        let found = engine.find_by_attr(
            &AttrQuery { file: Some("src/file_42.js".to_string()), ..AttrQuery::default() },
        );
        assert_eq!(found.len(), 5);
    }

    // ── B2 (RFD-71) MVCC acceptance tests ────────────────────────────

    /// B2 core property: visibility flips exactly at the manifest publish.
    /// An add WITHOUT flush is invisible to every public read; after flush
    /// (which publishes a new manifest version) the same read observes it.
    /// Proves the public read path no longer consults the live write buffer.
    #[test]
    fn test_b2_visibility_equals_publish() {
        let mut engine = GraphEngineV2::create_ephemeral();

        let n = make_v2_node("FUNCTION:vis@src/v.js", "FUNCTION", "vis", "src/v.js");
        let id = n.id;
        let v1 = NodeRecord {
            id,
            node_type: Some("FUNCTION".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("vis".to_string()),
            file: Some("src/v.js".to_string()),
            metadata: None,
            semantic_id: Some("FUNCTION:vis@src/v.js".to_string()),
        };

        // Add WITHOUT flush → uncommitted → invisible to all public reads.
        engine.add_nodes(vec![v1]);
        assert!(
            !engine.node_exists(id),
            "uncommitted add must be invisible (no dirty reads)"
        );
        assert!(engine.get_node(id).is_none(), "uncommitted add must be invisible");
        assert_eq!(engine.node_count(), 0, "uncommitted add must not count");
        assert!(
            engine.find_by_type("FUNCTION").is_empty(),
            "uncommitted add must not appear in find_by_type"
        );
        let q = AttrQuery::new().name("vis");
        assert!(
            engine.find_by_attr(&q).is_empty(),
            "uncommitted add must not appear in find_by_attr"
        );

        // Flush publishes a new manifest version → visibility flips ON.
        engine.flush().unwrap();
        assert!(engine.node_exists(id), "after publish the add is visible");
        assert_eq!(engine.get_node(id).unwrap().id, id);
        assert_eq!(engine.node_count(), 1);
        assert_eq!(engine.find_by_type("FUNCTION"), vec![id]);
        assert_eq!(engine.find_by_attr(&q), vec![id]);
    }

    /// B2: an edge added without flush is invisible; after publish it appears,
    /// and a delete is likewise invisible until its tombstone is published.
    #[test]
    fn test_b2_edge_visibility_and_delete_publish() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let a = make_v2_node("FUNCTION:a@src/a.js", "FUNCTION", "a", "src/a.js");
        let b = make_v2_node("FUNCTION:b@src/a.js", "FUNCTION", "b", "src/a.js");
        let (ida, idb) = (a.id, b.id);
        engine.store.add_nodes(vec![a, b]);
        engine.add_edges(vec![EdgeRecord {
            src: ida, dst: idb,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None, deleted: false,
        }], false);

        // Uncommitted: edge + endpoints invisible.
        assert!(engine.get_outgoing_edges(ida, None).is_empty());
        assert_eq!(engine.edge_count(), 0);

        engine.flush().unwrap();
        assert_eq!(engine.get_outgoing_edges(ida, None).len(), 1);
        assert_eq!(engine.edge_count(), 1);

        // Delete WITHOUT flush → invisible (edge still observable).
        engine.delete_edge(ida, idb, "CALLS");
        assert_eq!(
            engine.get_outgoing_edges(ida, None).len(),
            1,
            "uncommitted delete must be invisible"
        );

        // Publish the tombstone → delete becomes visible.
        engine.flush().unwrap();
        assert!(engine.get_outgoing_edges(ida, None).is_empty());
        assert_eq!(engine.edge_count(), 0);
    }

    /// B2 equivalence: public reads through the snapshot path return exactly the
    /// committed state, identical to the B1 `*_at` reads on the same version.
    #[test]
    fn test_b2_post_commit_equivalence_with_at_reads() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let n1 = make_v2_node("FUNCTION:f1@src/a.js", "FUNCTION", "f1", "src/a.js");
        let n2 = make_v2_node("CLASS:C@src/b.js", "CLASS", "C", "src/b.js");
        let (id1, id2) = (n1.id, n2.id);
        engine.store.add_nodes(vec![n1, n2]);
        engine.add_edges(vec![EdgeRecord {
            src: id1, dst: id2,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None, deleted: false,
        }], false);
        engine.flush().unwrap();

        // Public engine reads.
        let pub_node = engine.get_node(id1).unwrap();
        let pub_count = engine.node_count();
        let pub_edges = engine.get_outgoing_edges(id1, None);
        let pub_funcs = engine.find_by_type("FUNCTION");

        // Direct B1 `*_at` reads on the same published snapshot.
        let snap = engine.snapshot();
        let at_node = engine.store.get_node_at(&snap, id1).unwrap();
        let at_count = engine.store.node_count_at(&snap);
        let at_edges = engine.store.get_outgoing_edges_at(&snap, id1, None);
        let at_funcs = engine.store.find_node_ids_by_type_at(&snap, "FUNCTION");

        assert_eq!(pub_node.id, at_node.id);
        assert_eq!(pub_node.name.as_deref(), Some(at_node.name.as_str()));
        assert_eq!(pub_count, at_count);
        assert_eq!(pub_count, 2);
        assert_eq!(pub_edges.len(), at_edges.len());
        assert_eq!(pub_edges.len(), 1);
        assert_eq!(pub_funcs, at_funcs);
        assert_eq!(pub_funcs, vec![id1]);
    }

    // ── @materialize write-back (Gate B Stage 1) ─────────────────────

    /// A tiny `@materialize(edge_type="DEPENDS_ON")` rule over a committed graph must
    /// write its derived binary facts back AS DEPENDS_ON edges, each carrying the
    /// orchestrator-style provenance (`_source = rule_ast_hash`, `_generation = run_id`),
    /// committed by a single atomic manifest flip on top of the prior generation.
    #[test]
    fn materialize_writeback_produces_edges_with_provenance() {
        let mut engine = GraphEngineV2::create_ephemeral();

        // Commit a base graph: two modules, an IMPORTS_FROM edge a→b.
        let a = make_v2_node("a.js->MODULE->a", "MODULE", "a", "a.js");
        let b = make_v2_node("b.js->MODULE->b", "MODULE", "b", "b.js");
        let (id_a, id_b) = (a.id, b.id);
        let import_edge = EdgeRecordV2 {
            src: id_a,
            dst: id_b,
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                vec![a, b],
                vec![import_edge],
                &["a.js".to_string(), "b.js".to_string()],
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        // The generation the write-back will publish at (one past the current version).
        let gen = engine.snapshot().version + 1;

        // A binary @materialize rule: dep(X, Y) projects to a DEPENDS_ON edge.
        let src = r#"@materialize(edge_type = "DEPENDS_ON")
                     dep(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;

        let written = engine
            .eval_datalog_v2_materialize(src, crate::datalog::EvalLimits::none())
            .expect("write-back");
        assert_eq!(written, 1, "exactly one IMPORTS_FROM → one DEPENDS_ON");

        // Read back the materialized edge on the freshly published snapshot.
        let snap = engine.snapshot();
        let deps = engine.store.get_edges_by_type_at(&snap, "DEPENDS_ON");
        assert_eq!(deps.len(), 1, "one DEPENDS_ON edge was written back");
        assert_eq!(deps[0].src, id_a);
        assert_eq!(deps[0].dst, id_b);

        // Provenance: _source is the rule AST hash, _generation is the run id.
        let meta: serde_json::Value =
            serde_json::from_str(&deps[0].metadata).expect("provenance is JSON");
        let parsed = crate::datalog2::parser_ext::parse_ext_program(src).unwrap();
        let expected_hash =
            crate::datalog2::materialize::rule_ast_hash(&parsed.items[0].rule);
        assert_eq!(meta["_source"], serde_json::Value::String(expected_hash));
        assert_eq!(meta["_generation"], serde_json::json!(gen));

        // The base graph survived the additive write-back (run isolation: the flip layered
        // the derived edge on top of the prior generation, it did not replace it).
        assert!(engine.node_exists(id_a));
        assert!(engine.node_exists(id_b));
        assert_eq!(
            engine.store.get_edges_by_type_at(&snap, "IMPORTS_FROM").len(),
            1,
            "the source IMPORTS_FROM edge is intact"
        );
    }

    /// `mode = "additive"`: a program materializing into a SHARED edge type must never
    /// tombstone edges it did not derive. Pre-existing (analyzer-style) CALLS edge survives
    /// an incremental materialize whose program derives a DIFFERENT CALLS edge; a second
    /// run is a no-op (idempotent); and the exclusive default on the same store still
    /// removes underived edges of its own (exclusively-owned) type.
    #[test]
    fn additive_materialize_never_tombstones_shared_type() {
        let mut engine = GraphEngineV2::create_ephemeral();

        let x = make_v2_node("x.js->CALL->x", "CALL", "x", "x.js");
        let y = make_v2_node("y.js->METHOD->y", "METHOD", "y", "y.js");
        let a = make_v2_node("a.js->CALL->a", "CALL", "a", "a.js");
        let b = make_v2_node("b.js->METHOD->b", "METHOD", "b", "b.js");
        let (id_x, id_y, id_a, id_b) = (x.id, y.id, a.id, b.id);
        // Pre-existing CALLS x→y (an analyzer's edge, NOT derivable by the program) and the
        // LINKS base fact the program derives from.
        let analyzer_calls = EdgeRecordV2 {
            src: id_x,
            dst: id_y,
            edge_type: "CALLS".to_string(),
            metadata: String::new(),
        };
        let links = EdgeRecordV2 {
            src: id_a,
            dst: id_b,
            edge_type: "LINKS".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                vec![x, y, a, b],
                vec![analyzer_calls, links],
                &["x.js".to_string(), "y.js".to_string(), "a.js".to_string(), "b.js".to_string()],
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        let src = r#"@materialize(edge_type = "CALLS", mode = "additive")
                     r(A, B) :- edge(A, B, "LINKS")."#;

        // First run: adds the derived CALLS a→b, removes NOTHING.
        let (added, removed) = engine
            .eval_datalog_v2_materialize_incremental(src, crate::datalog::EvalLimits::none())
            .expect("additive write-back");
        assert_eq!((added, removed), (1, 0), "one new CALLS added, zero tombstoned");

        let snap = engine.snapshot();
        let calls = engine.store.get_edges_by_type_at(&snap, "CALLS");
        let keys: std::collections::BTreeSet<(u128, u128)> =
            calls.iter().map(|e| (e.src, e.dst)).collect();
        assert_eq!(
            keys,
            std::collections::BTreeSet::from([(id_x, id_y), (id_a, id_b)]),
            "the analyzer's CALLS x→y SURVIVES the additive materialize"
        );

        // Second run: nothing new to add, still nothing tombstoned (idempotent no-op).
        let (added2, removed2) = engine
            .eval_datalog_v2_materialize_incremental(src, crate::datalog::EvalLimits::none())
            .expect("additive re-run");
        assert_eq!((added2, removed2), (0, 0), "additive re-run is a no-op");

        // Contrast: the DEFAULT (exclusive) mode on an exclusively-owned type still
        // supersedes — an OWNED edge not derived this run is tombstoned.
        let stale_owned = EdgeRecordV2 {
            src: id_x,
            dst: id_b,
            edge_type: "OWNED".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(Vec::new(), vec![stale_owned], &[], HashMap::new(), &[])
            .expect("stale owned edge commit");
        let src_owned = r#"@materialize(edge_type = "OWNED")
                           o(A, B) :- edge(A, B, "LINKS")."#;
        let (o_added, o_removed) = engine
            .eval_datalog_v2_materialize_incremental(src_owned, crate::datalog::EvalLimits::none())
            .expect("exclusive write-back");
        assert_eq!(
            (o_added, o_removed),
            (1, 1),
            "exclusive mode adds the derived OWNED a→b and tombstones the underived x→b"
        );
    }

    /// A `@materialize` rule whose head is NOT binary aborts the run with a coded error
    /// BEFORE any commit — the prior generation must stay intact (abort-no-commit).
    #[test]
    fn materialize_writeback_aborts_no_commit_on_bad_head() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let n = make_v2_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js");
        engine
            .commit_batch_ext(vec![n], Vec::new(), &["a.js".to_string()], HashMap::new(), &[])
            .expect("base commit");
        let version_before = engine.snapshot().version;

        // Unary head under @materialize — cannot project to an edge.
        let src = r#"@materialize(edge_type = "T")
                     orphan(X) :- node(X, "FUNCTION")."#;
        let err = engine
            .eval_datalog_v2_materialize(src, crate::datalog::EvalLimits::none())
            .expect_err("a non-binary materialized head must abort");
        assert_eq!(err.code(), "E-MAT-002");

        // No commit happened: the published version is unchanged.
        assert_eq!(
            engine.snapshot().version,
            version_before,
            "abort-no-commit: the prior generation is intact"
        );
        assert!(engine.store.get_edges_by_type_at(&engine.snapshot(), "T").is_empty());
    }

    // ── Gate C EXIT on real storage: maintain_datalog_v2 ≡ scratch ───

    /// The Gate C EXIT on a live `storage_v2` graph (not the in-memory fixture): across a
    /// series of base-edge insertions committed to the real store, the relation maintained by
    /// `maintain_datalog_v2` (diff two pinned `ReadSnapshot`s → `maintain_incremental`) is
    /// byte-identical to a from-scratch evaluation of each new snapshot. DRed deletion is
    /// proven on the in-memory fixture across the same `StorageView` trait boundary; this test
    /// exercises the real `BorrowedLsmStorageView` end of it.
    #[test]
    fn maintain_datalog_v2_equals_scratch_on_real_store_over_cycles() {
        use crate::datalog2::exec::{Evaluation, Executor, DEFAULT_ITERATION_CAP};
        use crate::datalog2::parser_ext::parse_ext_program;
        use crate::datalog2::plan::plan_program;
        use crate::datalog2::stratify::stratify;
        use crate::datalog2::tag::BoolTag;
        use crate::datalog::EvalLimits;

        // Transitive closure over IMPORTS_FROM — negation-free, single recursive stratum.
        let src = "path(A, B) :- edge(A, B, \"IMPORTS_FROM\").\n\
                   path(A, B) :- edge(A, C, \"IMPORTS_FROM\"), path(C, B).";

        let mut engine = GraphEngineV2::create_ephemeral();
        // Commit eight module nodes m0..m7 plus a seed chain m0→m1→m2.
        let ids: Vec<u128> = (0..8u32)
            .map(|i| {
                let sid = format!("m{i}.js->MODULE->m{i}");
                make_v2_node(&sid, "MODULE", &format!("m{i}"), &format!("m{i}.js")).id
            })
            .collect();
        let nodes: Vec<_> = (0..8u32)
            .map(|i| make_v2_node(&format!("m{i}.js->MODULE->m{i}"), "MODULE", &format!("m{i}"), &format!("m{i}.js")))
            .collect();
        let imp = |s: usize, d: usize| EdgeRecordV2 {
            src: ids[s],
            dst: ids[d],
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                nodes,
                vec![imp(0, 1), imp(1, 2)],
                &(0..8).map(|i| format!("m{i}.js")).collect::<Vec<_>>(),
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        // Plan once (program is fixed); scratch eval helper over a pinned snapshot.
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let stats = crate::datalog2::builtin::Stats {
            total_nodes: 8,
            total_edges: 8,
            ..Default::default()
        };
        let plans = plan_program(&rules, &strat, &stats).expect("plan");
        let scratch_at = |engine: &GraphEngineV2| -> Evaluation {
            let snap = engine.snapshot();
            let view = crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
            Executor::<BoolTag>::with_limits(&view, EvalLimits::none(), DEFAULT_ITERATION_CAP)
                .evaluate(&plans, &rules, &strat)
                .expect("scratch")
        };

        let mut prev_eval = scratch_at(&engine);
        let mut prev_snap = engine.snapshot();
        let mut saw_growth = false;

        // Each cycle adds one IMPORTS_FROM edge (additive commit) and maintains incrementally.
        for (s, d) in [(2usize, 3usize), (3, 4), (0, 5), (5, 6), (4, 7), (6, 7)] {
            engine
                .commit_batch_ext(Vec::new(), vec![imp(s, d)], &[], HashMap::new(), &[])
                .expect("additive edge commit");

            let maintained = engine
                .maintain_datalog_v2(src, &prev_eval, prev_snap.clone(), EvalLimits::none())
                .expect("maintain")
                .expect("monotone envelope → Some, not a recompute fallback");
            let scratch = scratch_at(&engine);
            assert_eq!(
                maintained.relations, scratch.relations,
                "real-store maintain ≡ scratch after adding m{s}→m{d}"
            );
            if maintained.facts("path").len() > prev_eval.facts("path").len() {
                saw_growth = true;
            }
            prev_eval = maintained;
            prev_snap = engine.snapshot();
        }
        assert!(saw_growth, "the transitive closure grew under the seeded insertions");
    }

    /// why() on real storage: explain a transitive DEPENDS-style fact and get back the rule
    /// plus the ground body facts that derived it (the engine primitive behind Gate E's MCP
    /// `explain_fact`).
    #[test]
    fn explain_datalog_fact_returns_supporting_derivation_on_real_store() {
        use crate::datalog::{EvalLimits, Value};
        let src = "path(A, B) :- edge(A, B, \"IMPORTS_FROM\").\n\
                   path(A, B) :- edge(A, C, \"IMPORTS_FROM\"), path(C, B).";
        let mut engine = GraphEngineV2::create_ephemeral();
        let a = make_v2_node("a.js->MODULE->a", "MODULE", "a", "a.js");
        let b = make_v2_node("b.js->MODULE->b", "MODULE", "b", "b.js");
        let c = make_v2_node("c.js->MODULE->c", "MODULE", "c", "c.js");
        let (ia, ib, ic) = (a.id, b.id, c.id);
        let e = |s: u128, d: u128| EdgeRecordV2 {
            src: s,
            dst: d,
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                vec![a, b, c],
                vec![e(ia, ib), e(ib, ic)],
                &["a.js".into(), "b.js".into(), "c.js".into()],
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        // path(a,c) holds transitively via edge(a,b) ∧ path(b,c).
        let w = engine
            .explain_datalog_fact(src, "path", &[Value::Id(ia), Value::Id(ic)], EvalLimits::none())
            .expect("no eval error")
            .expect("path(a,c) is derivable");
        let preds: Vec<&str> = w.body.iter().map(|(p, _)| p.as_str()).collect();
        assert!(preds.contains(&"edge") && preds.contains(&"path"), "body = edge+path: {preds:?}");
        let path_fact = w.body.iter().find(|(p, _)| p == "path").map(|(_, t)| t).unwrap();
        assert_eq!(&path_fact[..], &[Value::Id(ib), Value::Id(ic)], "supported by path(b,c)");

        // A fact that does not hold has no derivation.
        let none = engine
            .explain_datalog_fact(src, "path", &[Value::Id(ic), Value::Id(ia)], EvalLimits::none())
            .expect("no eval error");
        assert!(none.is_none(), "path(c,a) is not derivable");
    }

    /// Gate D: incremental @materialize commits only the edge DELTA — adds new derived edges,
    /// tombstones gone ones, no-ops when nothing changed — instead of rewriting every edge.
    #[test]
    fn incremental_materialize_commits_only_the_edge_delta() {
        use crate::datalog::EvalLimits;
        let src = r#"@materialize(edge_type = "DEPENDS_ON")
                     dep(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;
        let mut engine = GraphEngineV2::create_ephemeral();
        let a = make_v2_node("a.js->MODULE->a", "MODULE", "a", "a.js");
        let b = make_v2_node("b.js->MODULE->b", "MODULE", "b", "b.js");
        let c = make_v2_node("c.js->MODULE->c", "MODULE", "c", "c.js");
        let (ia, ib, ic) = (a.id, b.id, c.id);
        let imp = |s: u128, d: u128| EdgeRecordV2 {
            src: s,
            dst: d,
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                vec![a, b, c],
                vec![imp(ia, ib), imp(ib, ic)],
                &["a.js".into(), "b.js".into(), "c.js".into()],
                HashMap::new(),
                &[],
            )
            .expect("base commit");
        let deps = |e: &GraphEngineV2| {
            e.store
                .get_edges_by_type_at(&e.snapshot(), "DEPENDS_ON")
                .into_iter()
                .map(|x| (x.src, x.dst))
                .collect::<std::collections::HashSet<_>>()
        };

        // First run: no prior DEPENDS_ON → both edges added.
        assert_eq!(
            engine.eval_datalog_v2_materialize_incremental(src, EvalLimits::none()).unwrap(),
            (2, 0)
        );
        assert_eq!(deps(&engine), [(ia, ib), (ib, ic)].into_iter().collect());

        // Add IMPORTS_FROM c→a → exactly one DEPENDS_ON added, nothing rewritten.
        engine
            .commit_batch_ext(Vec::new(), vec![imp(ic, ia)], &[], HashMap::new(), &[])
            .expect("add edge");
        assert_eq!(
            engine.eval_datalog_v2_materialize_incremental(src, EvalLimits::none()).unwrap(),
            (1, 0)
        );
        assert_eq!(deps(&engine), [(ia, ib), (ib, ic), (ic, ia)].into_iter().collect());

        // No base change → a no-op (0,0): the write is genuinely delta-only.
        assert_eq!(
            engine.eval_datalog_v2_materialize_incremental(src, EvalLimits::none()).unwrap(),
            (0, 0)
        );

        // Remove IMPORTS_FROM a→b → the derived DEPENDS_ON a→b is tombstoned (1 removed).
        engine.delete_edge(ia, ib, "IMPORTS_FROM");
        engine.flush().expect("flush base delete");
        assert_eq!(
            engine.eval_datalog_v2_materialize_incremental(src, EvalLimits::none()).unwrap(),
            (0, 1)
        );
        assert_eq!(
            deps(&engine),
            [(ib, ic), (ic, ia)].into_iter().collect(),
            "DEPENDS_ON a→b tombstoned; the rest intact"
        );
    }

    /// Gate D2: the maintain-based `@materialize` (`eval_datalog_v2_maintain_writeback`) produces
    /// a materialized edge set byte-identical to a full from-scratch derivation, across mixed
    /// insert/delete edits on the REAL store. The derive is delta-seeded (work-proportional);
    /// this proves it stays equivalent to recompute (the cross-run cache wiring rides on this).
    #[test]
    fn maintain_writeback_materialize_equals_full_scratch_on_real_store() {
        use crate::datalog::{EvalLimits, Value};
        let src = r#"@materialize(edge_type = "DEPENDS_ON")
                     dep(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;

        // Full from-scratch derivation of the `dep` relation at the engine's current snapshot.
        let dep_scratch = |engine: &GraphEngineV2| -> std::collections::HashSet<(u128, u128)> {
            let snap = engine.snapshot();
            let all_nodes = engine.store.find_nodes_at(&snap, None, None);
            let mut nbt: HashMap<String, u64> = HashMap::new();
            for n in &all_nodes {
                *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
            }
            let stats = crate::datalog2::builtin::Stats {
                total_nodes: all_nodes.len() as u64,
                total_edges: engine.store.edge_count_at(&snap) as u64,
                nodes_by_type: nbt,
            };
            let view = crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
            let (eval, _specs) = crate::datalog2::evaluate_with_materialize(
                &view,
                src,
                stats,
                EvalLimits::none(),
                crate::datalog2::events::EventLog::discard(),
            )
            .expect("scratch eval");
            eval.facts("dep")
                .iter()
                .map(|t| match (&t[0], &t[1]) {
                    (Value::Id(a), Value::Id(b)) => (*a, *b),
                    _ => panic!("dep tuple shape"),
                })
                .collect()
        };
        // The Evaluation (all derived relations) at the current snapshot — the `prev` for maintain.
        let eval_at = |engine: &GraphEngineV2| -> crate::datalog2::exec::Evaluation {
            let snap = engine.snapshot();
            let all_nodes = engine.store.find_nodes_at(&snap, None, None);
            let mut nbt: HashMap<String, u64> = HashMap::new();
            for n in &all_nodes {
                *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
            }
            let stats = crate::datalog2::builtin::Stats {
                total_nodes: all_nodes.len() as u64,
                total_edges: engine.store.edge_count_at(&snap) as u64,
                nodes_by_type: nbt,
            };
            let view = crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
            crate::datalog2::evaluate_with_materialize(
                &view,
                src,
                stats,
                EvalLimits::none(),
                crate::datalog2::events::EventLog::discard(),
            )
            .expect("eval")
            .0
        };
        let deps = |e: &GraphEngineV2| {
            e.store
                .get_edges_by_type_at(&e.snapshot(), "DEPENDS_ON")
                .into_iter()
                .map(|x| (x.src, x.dst))
                .collect::<std::collections::HashSet<(u128, u128)>>()
        };

        let mut engine = GraphEngineV2::create_ephemeral();
        let ids: Vec<u128> = (0..6u32)
            .map(|i| make_v2_node(&format!("m{i}.js->MODULE->m{i}"), "MODULE", &format!("m{i}"), &format!("m{i}.js")).id)
            .collect();
        let nodes: Vec<_> = (0..6u32)
            .map(|i| make_v2_node(&format!("m{i}.js->MODULE->m{i}"), "MODULE", &format!("m{i}"), &format!("m{i}.js")))
            .collect();
        let imp = |s: usize, d: usize| EdgeRecordV2 {
            src: ids[s],
            dst: ids[d],
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                nodes,
                vec![imp(0, 1), imp(1, 2)],
                &(0..6).map(|i| format!("m{i}.js")).collect::<Vec<_>>(),
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        // Initial full materialize (cache-miss equivalent), then snapshot the prior state.
        engine
            .eval_datalog_v2_materialize_incremental(src, EvalLimits::none())
            .expect("initial materialize");
        assert_eq!(deps(&engine), dep_scratch(&engine), "initial materialize ≡ scratch");
        let mut prev_eval = eval_at(&engine);
        let mut prev_snap = engine.snapshot();

        // Mixed insert/delete edits; each maintained materialize must equal a full scratch one.
        let edits: [(bool, usize, usize); 6] =
            [(true, 2, 3), (true, 0, 4), (true, 3, 5), (false, 0, 1), (true, 4, 5), (false, 1, 2)];
        for (add, s, d) in edits {
            if add {
                engine
                    .commit_batch_ext(Vec::new(), vec![imp(s, d)], &[], HashMap::new(), &[])
                    .expect("additive edge commit");
            } else {
                engine.delete_edge(ids[s], ids[d], "IMPORTS_FROM");
                engine.flush().expect("base delete flush");
            }

            engine
                .eval_datalog_v2_maintain_writeback(src, &prev_eval, prev_snap.clone(), EvalLimits::none())
                .expect("maintain write-back");

            assert_eq!(
                deps(&engine),
                dep_scratch(&engine),
                "maintained DEPENDS_ON ≡ scratch after edit add={add} m{s}→m{d}"
            );

            prev_eval = eval_at(&engine);
            prev_snap = engine.snapshot();
        }
    }

    /// Gate D2: the cached `@materialize` entry keeps the materialized edge set ≡ a full scratch
    /// derivation across calls WITHOUT an explicit prior — the in-engine pinned cache supplies it
    /// — and actually takes the work-proportional MAINTAIN path on every call after the first
    /// (proven via the test-only hit counter; a correctness-only assertion could not establish
    /// this, since maintain and scratch yield identical results by construction).
    #[test]
    fn cached_materialize_maintains_across_calls_and_equals_scratch() {
        use crate::datalog::{EvalLimits, Value};
        use std::sync::atomic::Ordering;
        let src = r#"@materialize(edge_type = "DEPENDS_ON")
                     dep(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;

        let dep_scratch = |engine: &GraphEngineV2| -> std::collections::HashSet<(u128, u128)> {
            let snap = engine.snapshot();
            let all_nodes = engine.store.find_nodes_at(&snap, None, None);
            let mut nbt: HashMap<String, u64> = HashMap::new();
            for n in &all_nodes {
                *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
            }
            let stats = crate::datalog2::builtin::Stats {
                total_nodes: all_nodes.len() as u64,
                total_edges: engine.store.edge_count_at(&snap) as u64,
                nodes_by_type: nbt,
            };
            let view = crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
            let (eval, _s) = crate::datalog2::evaluate_with_materialize(
                &view,
                src,
                stats,
                EvalLimits::none(),
                crate::datalog2::events::EventLog::discard(),
            )
            .expect("scratch");
            eval.facts("dep")
                .iter()
                .map(|t| match (&t[0], &t[1]) {
                    (Value::Id(a), Value::Id(b)) => (*a, *b),
                    _ => panic!("dep tuple shape"),
                })
                .collect()
        };
        let deps = |e: &GraphEngineV2| {
            e.store
                .get_edges_by_type_at(&e.snapshot(), "DEPENDS_ON")
                .into_iter()
                .map(|x| (x.src, x.dst))
                .collect::<std::collections::HashSet<(u128, u128)>>()
        };

        let mut engine = GraphEngineV2::create_ephemeral();
        let ids: Vec<u128> = (0..6u32)
            .map(|i| make_v2_node(&format!("m{i}.js->MODULE->m{i}"), "MODULE", &format!("m{i}"), &format!("m{i}.js")).id)
            .collect();
        let nodes: Vec<_> = (0..6u32)
            .map(|i| make_v2_node(&format!("m{i}.js->MODULE->m{i}"), "MODULE", &format!("m{i}"), &format!("m{i}.js")))
            .collect();
        let imp = |s: usize, d: usize| EdgeRecordV2 {
            src: ids[s],
            dst: ids[d],
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                nodes,
                vec![imp(0, 1), imp(1, 2)],
                &(0..6).map(|i| format!("m{i}.js")).collect::<Vec<_>>(),
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        // First call: cache miss ⇒ full eval (no maintain hit), then the cache is populated.
        engine
            .eval_datalog_v2_materialize_cached(src, EvalLimits::none())
            .expect("first materialize");
        assert_eq!(deps(&engine), dep_scratch(&engine), "first (miss) ≡ scratch");
        assert_eq!(engine.datalog2_maintain_hits.load(Ordering::Relaxed), 0, "first call is a miss");
        assert_eq!(engine.datalog2_materialize_cache.len(), 1, "cache populated after first call");

        // Subsequent calls: each must take the MAINTAIN path (hit) and stay ≡ scratch.
        let edits: [(bool, usize, usize); 6] =
            [(true, 2, 3), (true, 0, 4), (true, 3, 5), (false, 0, 1), (true, 4, 5), (false, 1, 2)];
        for (i, (add, s, d)) in edits.into_iter().enumerate() {
            if add {
                engine
                    .commit_batch_ext(Vec::new(), vec![imp(s, d)], &[], HashMap::new(), &[])
                    .expect("additive edge commit");
            } else {
                engine.delete_edge(ids[s], ids[d], "IMPORTS_FROM");
                engine.flush().expect("base delete flush");
            }
            engine
                .eval_datalog_v2_materialize_cached(src, EvalLimits::none())
                .expect("cached materialize");
            assert_eq!(
                deps(&engine),
                dep_scratch(&engine),
                "cached DEPENDS_ON ≡ scratch after edit add={add} m{s}→m{d}"
            );
            assert_eq!(
                engine.datalog2_maintain_hits.load(Ordering::Relaxed),
                (i as u64) + 1,
                "maintain path fired on cache hit #{}",
                i + 1
            );
        }
        assert_eq!(
            engine.datalog2_materialize_cache.len(),
            1,
            "cache holds exactly one generation per program"
        );
    }

    /// Gate D2: the BUNDLED `depends.dl` (the actual prod rule — multi-leg: edge + node×2 +
    /// attr×3 + neq, not the single-leg toy rule the other D2 tests use) maintains correctly
    /// through the cached path. Proves the work-proportional prod DEPENDS_ON derivation stays ≡
    /// full scratch across mixed insert/delete edits, with the MAINTAIN path actually firing.
    #[test]
    fn cached_materialize_bundled_depends_dl_equals_scratch_on_real_store() {
        use crate::datalog::{EvalLimits, Value};
        use std::sync::atomic::Ordering;
        let src = crate::datalog2::stdlib::DEPENDS_DL;

        let depends_scratch = |engine: &GraphEngineV2| -> std::collections::HashSet<(u128, u128)> {
            let snap = engine.snapshot();
            let all_nodes = engine.store.find_nodes_at(&snap, None, None);
            let mut nbt: HashMap<String, u64> = HashMap::new();
            for n in &all_nodes {
                *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
            }
            let stats = crate::datalog2::builtin::Stats {
                total_nodes: all_nodes.len() as u64,
                total_edges: engine.store.edge_count_at(&snap) as u64,
                nodes_by_type: nbt,
            };
            let view = crate::datalog2::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
            let (eval, _s) = crate::datalog2::evaluate_with_materialize(
                &view,
                src,
                stats,
                EvalLimits::none(),
                crate::datalog2::events::EventLog::discard(),
            )
            .expect("scratch");
            eval.facts("depends")
                .iter()
                .map(|t| match (&t[0], &t[1]) {
                    (Value::Id(a), Value::Id(b)) => (*a, *b),
                    _ => panic!("depends tuple shape"),
                })
                .collect()
        };
        let deps = |e: &GraphEngineV2| {
            e.store
                .get_edges_by_type_at(&e.snapshot(), "DEPENDS_ON")
                .into_iter()
                .map(|x| (x.src, x.dst))
                .collect::<std::collections::HashSet<(u128, u128)>>()
        };

        let mut engine = GraphEngineV2::create_ephemeral();
        // Distinct-file MODULE nodes so the depends.dl file-attr join + neq fire.
        let ids: Vec<u128> = (0..6u32)
            .map(|i| make_v2_node(&format!("m{i}.js->MODULE->m{i}"), "MODULE", &format!("m{i}"), &format!("m{i}.js")).id)
            .collect();
        let nodes: Vec<_> = (0..6u32)
            .map(|i| make_v2_node(&format!("m{i}.js->MODULE->m{i}"), "MODULE", &format!("m{i}"), &format!("m{i}.js")))
            .collect();
        let imp = |s: usize, d: usize| EdgeRecordV2 {
            src: ids[s],
            dst: ids[d],
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                nodes,
                vec![imp(0, 1), imp(1, 2)],
                &(0..6).map(|i| format!("m{i}.js")).collect::<Vec<_>>(),
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        engine
            .eval_datalog_v2_materialize_cached(src, EvalLimits::none())
            .expect("first materialize");
        assert_eq!(deps(&engine), depends_scratch(&engine), "first (miss) ≡ scratch");

        let edits: [(bool, usize, usize); 6] =
            [(true, 2, 3), (true, 0, 4), (true, 3, 5), (false, 0, 1), (true, 4, 5), (false, 1, 2)];
        for (i, (add, s, d)) in edits.into_iter().enumerate() {
            if add {
                engine
                    .commit_batch_ext(Vec::new(), vec![imp(s, d)], &[], HashMap::new(), &[])
                    .expect("additive edge commit");
            } else {
                engine.delete_edge(ids[s], ids[d], "IMPORTS_FROM");
                engine.flush().expect("base delete flush");
            }
            engine
                .eval_datalog_v2_materialize_cached(src, EvalLimits::none())
                .expect("cached materialize");
            assert_eq!(
                deps(&engine),
                depends_scratch(&engine),
                "bundled depends.dl maintained ≡ scratch after edit add={add} m{s}→m{d}"
            );
            assert_eq!(
                engine.datalog2_maintain_hits.load(Ordering::Relaxed),
                (i as u64) + 1,
                "maintain path fired on cache hit #{}",
                i + 1
            );
        }
    }

    /// Gate D2 perf evidence (ignored — run on demand like Gate A): on a sizeable IMPORTS_FROM
    /// graph, a 1-edge reanalysis through the cached MAINTAIN path is faster than the full
    /// from-scratch derivation, and writes only the 1-edge delta.
    ///
    /// IMPORTANT — what this does and does NOT show. The maintain path still pays `diff_base`'s
    /// FULL base scan + plan/index setup (the fixed cost both paths share); it only skips the
    /// per-edge JOIN. On THIS clean 1:1-module graph the join is cheap, so the fixed scan
    /// dominates and the speedup is modest (~2× at N=1500) and stays ~flat as N grows (both legs
    /// scale linearly). The real win is workload-dependent: on the production corpus the depends.dl
    /// join was the 97s cost (messy attr/node fan-out) while the base scan is sub-second, so
    /// maintain skips nearly all the work — but that ≥5× ratio can only be shown on the real corpus
    /// (the Gate D2 corpus-benchmark EXIT), not a clean synthetic. Two follow-ups this measurement
    /// motivates: a version-delta-scoped `diff_base` (read only segments newer than prev_snapshot →
    /// sublinear scan, raising the floor) and confirming maintain reuses rather than rebuilds the
    /// join indices. This test asserts only the DIRECTION (maintain strictly faster + exact delta).
    ///
    /// `cargo test --release --lib cached_materialize_reanalysis_is_work_proportional -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn cached_materialize_reanalysis_is_work_proportional() {
        use crate::datalog::EvalLimits;
        use std::sync::atomic::Ordering;
        use std::time::Instant;
        let src = crate::datalog2::stdlib::DEPENDS_DL;

        const N: usize = 1500;
        let mut engine = GraphEngineV2::create_ephemeral();
        let ids: Vec<u128> = (0..N)
            .map(|i| make_v2_node(&format!("m{i}.js->MODULE->m{i}"), "MODULE", &format!("m{i}"), &format!("m{i}.js")).id)
            .collect();
        let nodes: Vec<_> = (0..N)
            .map(|i| make_v2_node(&format!("m{i}.js->MODULE->m{i}"), "MODULE", &format!("m{i}"), &format!("m{i}.js")))
            .collect();
        let imp = |s: usize, d: usize| EdgeRecordV2 {
            src: ids[s],
            dst: ids[d],
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        // Each module imports the next three → ~3*N distinct-pair IMPORTS_FROM edges.
        let mut edges = Vec::new();
        for i in 0..N {
            for k in 1..=3 {
                if i + k < N {
                    edges.push(imp(i, i + k));
                }
            }
        }
        let n_edges = edges.len();
        engine
            .commit_batch_ext(
                nodes,
                edges,
                &(0..N).map(|i| format!("m{i}.js")).collect::<Vec<_>>(),
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        // Full materialize (cache miss).
        let t0 = Instant::now();
        let (added0, _) = engine
            .eval_datalog_v2_materialize_cached(src, EvalLimits::none())
            .expect("full materialize");
        let t_full = t0.elapsed();
        assert_eq!(engine.datalog2_maintain_hits.load(Ordering::Relaxed), 0, "first call is a miss");
        assert_eq!(added0, n_edges, "full run materializes one DEPENDS_ON per distinct import");

        // 1-edge reanalysis (cache hit → maintain). (0 → N-2) is not among the seeded next-three.
        engine
            .commit_batch_ext(Vec::new(), vec![imp(0, N - 2)], &[], HashMap::new(), &[])
            .expect("reanalysis edge commit");
        let t1 = Instant::now();
        let (added1, removed1) = engine
            .eval_datalog_v2_materialize_cached(src, EvalLimits::none())
            .expect("reanalysis materialize");
        let t_maintain = t1.elapsed();
        assert_eq!(engine.datalog2_maintain_hits.load(Ordering::Relaxed), 1, "reanalysis took the maintain path");
        assert_eq!((added1, removed1), (1, 0), "reanalysis writes exactly the 1-edge delta");

        let ratio = t_full.as_secs_f64() / t_maintain.as_secs_f64().max(1e-9);
        println!(
            "[D2 perf] N={N} modules, {n_edges} IMPORTS_FROM | full-eval {:?} | 1-edge maintain {:?} | speedup {:.1}× \
             (clean 1:1 graph → scan-bound; ≥5× is corpus-dependent, see doc)",
            t_full, t_maintain, ratio
        );
        // Direction only: maintain skips the join so it is strictly faster than full eval. The
        // magnitude is workload-dependent (the ≥5× target is the corpus-benchmark EXIT).
        assert!(
            t_maintain < t_full,
            "1-edge reanalysis (maintain) must be faster than full eval: full={:?} maintain={:?} ({:.1}×)",
            t_full,
            t_maintain,
            ratio
        );
    }
}
