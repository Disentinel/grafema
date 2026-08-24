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

/// The `_source` provenance stamp of a materialized node's metadata, if present. Used to
/// decide ownership: a node is OWNED by a deriving rule iff its stored `_source` equals
/// that rule's `rule_ast_hash`. Returns `None` for nodes with no/unparseable metadata or
/// no `_source` (a foreign producer or a plain analyzer node).
fn materialized_source(metadata: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(metadata)
        .ok()
        .and_then(|m| m.get("_source").and_then(|s| s.as_str().map(String::from)))
}

/// The user-visible surface of a node's metadata: the parsed object with the volatile
/// `_generation` bookkeeping field removed. `_generation` advances every run even when
/// nothing a query can observe changed, so it MUST be excluded from any "did the surface
/// change?" comparison — otherwise an unchanged owned node would be rewritten every run.
/// `_source` is kept (it is part of identity/ownership and is constant for an owned node).
fn metadata_surface(metadata: &str) -> serde_json::Value {
    match serde_json::from_str::<serde_json::Value>(metadata) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.remove("_generation");
            serde_json::Value::Object(map)
        }
        Ok(other) => other,
        Err(_) => serde_json::Value::Null,
    }
}

/// Decide whether a freshly-derived `@materialize_node` node should REWRITE the node
/// already stored at the same id. Returns `true` only when the stored node is OWNED by
/// the SAME deriving rule (its `_source` matches `new`'s — a FOREIGN producer's node with
/// a different/absent `_source` is never clobbered) AND its user-visible surface differs
/// from the new derivation: any of `name`, `file`, `node_type`, or a `meta(...)` column,
/// with the volatile `_generation` bookkeeping field excluded. This restores last-write-
/// wins for a rule's own nodes (the plugin contract) — e.g. an ISSUE whose `msg` changes
/// after a renamed callee — while keeping an unchanged owned node a true idempotent no-op
/// (no churn rewrite).
fn owned_node_surface_changed(new: &NodeRecordV2, stored: &NodeRecordV2) -> bool {
    // Eligibility: only our OWN nodes may be rewritten (never a foreign producer's).
    match (materialized_source(&new.metadata), materialized_source(&stored.metadata)) {
        (Some(new_src), Some(stored_src)) if new_src == stored_src => {}
        _ => return false,
    }
    new.node_type != stored.node_type
        || new.name != stored.name
        || new.file != stored.file
        || metadata_surface(&new.metadata) != metadata_surface(&stored.metadata)
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

    /// Where the derive engine takes this database's rules from. Loaded from
    /// `db_config.json` at open, defaulted to `Text` at create, and re-persisted by
    /// [`GraphEngineV2::set_rule_source`]. Cached here because every derive entry
    /// consults it and re-reading the file per query would be a syscall on the hot path.
    rule_source: crate::derive::RuleSource,

    /// Whether this database runs under ROFL rules
    /// ([`crate::storage_v2::multi_shard::DatabaseConfig::rofl_mode`]).
    ///
    /// Loaded from `db_config.json` at open and at create, `false` for an ephemeral engine.
    /// The engine only READS it here; no behavior branches on it yet — wiring the ROFL
    /// checks is separate work. What this field buys now is that the marker has a durable
    /// home that survives a restart and a `clear_durable`, so that later work has something
    /// trustworthy to branch on.
    rofl_mode: bool,
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
    /// W4 #2: when `true`, the buffer-pressure auto-flush hooks at the end of
    /// `add_nodes`/`add_edges` are inert. Set only for the brief apply phase of an ATOMIC
    /// multi-step write-back (the `@materialize` delta — see [`Self::materialize_writeback_delta`]),
    /// where an intra-add `store.flush_all` would publish the adds while the run's
    /// `pending_tombstone_*` retractions are still engine-side, exposing a torn intermediate
    /// version. Always restored to its prior value via [`Self::with_auto_flush_suppressed`];
    /// the explicit `flush()` that closes the delta is never suppressed, so durability and
    /// the single atomic publish are preserved. Default `false` — every other write path
    /// keeps its OOM-safeguard auto-flush.
    suppress_auto_flush: bool,
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
    /// W7: size-tiered fanout for the per-commit auto-compaction (see
    /// `CompactionConfig::l1_fanout`). Default 4.0 (defer the O(|L1|) full rewrite
    /// while L0 < L1/4). `f64::INFINITY` reverts to the legacy always-full-merge.
    /// Settable for the acceptance bench's A/B.
    auto_compact_fanout: f64,
    /// MVCC C3.a: count of auto-compaction rounds fired during bulk-load
    /// (diagnostics / acceptance bench).
    auto_compactions: u64,
    /// Gate D2: per-program cross-call cache of `(pinned prior snapshot, prior Evaluation)`
    /// for work-proportional `@materialize`. Keyed by a stable hash of the program source. A
    /// cache hit lets [`Self::eval_derive_materialize_cached`] MAINTAIN (delta-seeded)
    /// instead of full-eval; a miss (first run / restart / outside the monotone envelope) falls
    /// back to a full eval. Holding the [`ReadSnapshot`] pins that version (its segments survive
    /// GC); replacing the entry drops the old pin, so retained disk is bounded to one prior
    /// generation per materialized program.
    derive_materialize_cache: std::collections::HashMap<
        u64,
        (
            crate::storage_v2::read_snapshot::ReadSnapshot,
            crate::derive::exec::Evaluation,
        ),
    >,
    /// W9 fix #1a: version-keyed cache of the planner [`crate::derive::builtin::Stats`]
    /// (total nodes/edges + per-type node counts). Stats are a pure function of the
    /// committed data visible to one snapshot. The key is `(version, tombstone Arc)`:
    /// version alone is NOT enough, because the delete→re-add path
    /// (`ManifestStore::remove_tombstone_nodes`/`_edges` from [`GraphStore::add_nodes`]/
    /// [`GraphStore::add_edges`]) resurrects committed records IN the current version
    /// without a version bump. That mutation always rebuilds the manifest's tombstone
    /// `Arc`, so `Arc::ptr_eq` on the snapshot's `tombstones` completes the identity:
    /// same version + same tombstone Arc ⇒ identical visible data (segments are
    /// immutable per version; the tombstone set is the only in-place-mutable input).
    /// Holding the `Arc` (not a raw pointer) rules out ABA reuse.
    /// Before this cache EVERY derive-engine entry re-scanned all ~500k node records per
    /// call (~27s aggregate over a 20-pack `@materialize` run) just to count types.
    /// `Mutex` because the eval entries take `&self`.
    derive_stats_cache: std::sync::Mutex<
        Option<(u64, Arc<crate::storage_v2::shard::TombstoneSet>, crate::derive::builtin::Stats)>,
    >,
    /// W9 fix #1b: cross-evaluation shared home for the executor's Part-A build-once
    /// indexes, version-keyed with edge-type-aware carry-forward across `@materialize`
    /// write-back commits. See [`crate::derive::exec::SharedIndexCaches`] for the
    /// soundness invariant (seed only on exact version match; the write-back path calls
    /// `retain_for_commit` with exactly what its commit touched).
    derive_shared_indexes: crate::derive::exec::SharedIndexCaches,
    /// Test-only: counts how many times [`Self::derive_for_materialize`] took the work-
    /// proportional MAINTAIN path (vs a from-scratch recompute). Lets the cached-materialize
    /// proof assert the incremental path actually fired — a correctness-only check can't, since
    /// maintain and scratch yield identical results by construction. Per-engine (no cross-test
    /// race); atomic so it can be bumped through `&self`.
    #[cfg(test)]
    derive_maintain_hits: std::sync::atomic::AtomicU64,
    /// Test-only: counts how many times [`Self::derive_for_materialize`] took the
    /// UNCHANGED-graph short-circuit (same manifest version ⇒ the cached evaluation is
    /// returned verbatim, no diff/maintain/scratch work at all).
    #[cfg(test)]
    derive_unchanged_hits: std::sync::atomic::AtomicU64,
}

// ── Constructors ────────────────────────────────────────────────────

impl GraphEngineV2 {
    /// Create a new database on disk at the given path.
    ///
    /// Uses `ResourceManager::auto_tune()` to determine shard count
    /// based on available RAM and CPU cores.
    ///
    /// Refuses, WITHOUT WRITING ANYTHING, if a database already lives at the path. The
    /// order used to be the other way round: `MultiShardStore::create` overwrote
    /// `db_config.json` with a fresh default, and only the following `ManifestStore::create`
    /// noticed the database and returned "Database already exists at path". The caller got
    /// an error and believed nothing had happened, while the existing database had just
    /// lost its durable flags — its rule source and its ROFL marker — and came back on the
    /// next open as an ordinary text-mode database. Reachable in production, not a thought
    /// experiment: `DatabaseManager::new` starts with an EMPTY map and never scans the disk,
    /// and `create_database` checks only that map, so after a server restart an ordinary
    /// `createDatabase("foo")` over an existing `foo.rfdb` lands exactly here.
    ///
    /// Both authorities are checked, because either one alone leaves a hole: `current.json`
    /// is the manifest's own existence marker, and `db_config.json` is the file the server
    /// itself uses to recognise a v2 database (`DatabaseManager::create_default_from_path`).
    pub fn create<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = path.as_ref();
        std::fs::create_dir_all(path)?;
        if path.join("current.json").exists() || path.join("db_config.json").exists() {
            return Err(crate::error::GraphError::InvalidFormat(
                "Database already exists at path".to_string(),
            ));
        }
        let profile = ResourceManager::auto_tune();
        let store = MultiShardStore::create(path, profile.shard_count)?;
        let manifest = ManifestStore::create(path)?;
        // `MultiShardStore::create` just wrote `db_config.json`; read the rule source back
        // from it rather than assuming the default, so create and open agree by
        // construction on where this database's rules live.
        let config = crate::storage_v2::multi_shard::DatabaseConfig::read_from(path)?
            .ok_or_else(|| crate::error::GraphError::InvalidFormat("Missing db_config.json after create".to_string()))?;

        Ok(Self {
            store,
            rule_source: config.rule_source,
            rofl_mode: config.rofl_mode,
            manifest: std::sync::Mutex::new(manifest),
            path: Some(path.to_path_buf()),
            ephemeral: false,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            declared_fields: Vec::new(),
            cached_profile: profile,
            last_resource_check: Instant::now(),
            suppress_auto_flush: false,
            bulk_load_active: false,
            auto_compact_threshold: 8,
            auto_compact_fanout: 4.0,
            auto_compactions: 0,
            derive_materialize_cache: std::collections::HashMap::new(),
            derive_stats_cache: std::sync::Mutex::new(None),
            derive_shared_indexes: crate::derive::exec::SharedIndexCaches::new(),
            #[cfg(test)]
            derive_maintain_hits: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            derive_unchanged_hits: std::sync::atomic::AtomicU64::new(0),
            #[cfg(feature = "embedding")]
            embedding_engine: Self::init_embedding_engine(Some(path)),
        })
    }

    /// Create an ephemeral (in-memory only) engine for tests.
    pub fn create_ephemeral() -> Self {
        Self {
            store: MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT),
            rule_source: crate::derive::RuleSource::default(),
            rofl_mode: false,
            manifest: std::sync::Mutex::new(ManifestStore::ephemeral()),
            path: None,
            ephemeral: true,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            declared_fields: Vec::new(),
            cached_profile: TuningProfile::default(),
            last_resource_check: Instant::now(),
            suppress_auto_flush: false,
            bulk_load_active: false,
            auto_compact_threshold: 8,
            auto_compact_fanout: 4.0,
            auto_compactions: 0,
            derive_materialize_cache: std::collections::HashMap::new(),
            derive_stats_cache: std::sync::Mutex::new(None),
            derive_shared_indexes: crate::derive::exec::SharedIndexCaches::new(),
            #[cfg(test)]
            derive_maintain_hits: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            derive_unchanged_hits: std::sync::atomic::AtomicU64::new(0),
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
        // `MultiShardStore::open` already required `db_config.json`; re-read it for the
        // rule-source flag (an older file without the field means Text, by serde default).
        let config = crate::storage_v2::multi_shard::DatabaseConfig::read_from(path)?
            .ok_or_else(|| crate::error::GraphError::InvalidFormat("Missing db_config.json".to_string()))?;

        Ok(Self {
            store,
            rule_source: config.rule_source,
            rofl_mode: config.rofl_mode,
            manifest: std::sync::Mutex::new(manifest),
            path: Some(path.to_path_buf()),
            ephemeral: false,
            pending_tombstone_nodes: HashSet::new(),
            pending_tombstone_edges: HashSet::new(),
            declared_fields: Vec::new(),
            cached_profile: profile,
            last_resource_check: Instant::now(),
            suppress_auto_flush: false,
            bulk_load_active: false,
            auto_compact_threshold: 8,
            auto_compact_fanout: 4.0,
            auto_compactions: 0,
            derive_materialize_cache: std::collections::HashMap::new(),
            derive_stats_cache: std::sync::Mutex::new(None),
            derive_shared_indexes: crate::derive::exec::SharedIndexCaches::new(),
            #[cfg(test)]
            derive_maintain_hits: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            derive_unchanged_hits: std::sync::atomic::AtomicU64::new(0),
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

    /// The planner's [`crate::derive::builtin::Stats`] at `snapshot`'s version, served
    /// from the per-engine version-keyed cache (W9 fix #1a). On a miss the per-type
    /// counts come from `MultiShardStore::count_nodes_by_type_at` — a columnar id+type
    /// walk, NOT the full record materialization the old inline scan paid per call
    /// (~500k `NodeRecordV2` copies, ~27s aggregate over a 20-pack `@materialize` run).
    /// Stale entries are impossible: a commit publishes a new manifest version, and the
    /// one same-version data mutation (the delete→re-add un-tombstone) publishes a fresh
    /// tombstone `Arc` — the cache compares BOTH (see the field doc for why version
    /// alone is insufficient).
    ///
    /// The reserved reflected-rule type
    /// ([`crate::derive::reflect::REFLECT_NODE_TYPE`]) is SUBTRACTED here. This counter
    /// reads the store directly, not through
    /// [`crate::derive::storage_glue::StorageView`], so it is the one place the view's
    /// isolation of the rule store does not reach — and these numbers are not decoration:
    /// they feed the cost model and the cartesian-product gate (`E-PLAN-003`). Left in,
    /// `total_nodes` (and a `$rofl/reflect` entry in the per-type map) would grow with the
    /// number of REFLECTED RULES, so the same program could plan differently in text mode
    /// and in store mode — which is exactly the difference a text-vs-store differential
    /// exists to rule out.
    fn derive_stats(
        &self,
        snapshot: &crate::storage_v2::read_snapshot::ReadSnapshot,
    ) -> crate::derive::builtin::Stats {
        if let Some((v, t, stats)) = self.derive_stats_cache.lock().unwrap().as_ref() {
            if *v == snapshot.version && Arc::ptr_eq(t, &snapshot.tombstones) {
                return stats.clone();
            }
        }
        let mut nodes_by_type = self.store.count_nodes_by_type_at(snapshot);
        nodes_by_type.remove(crate::derive::reflect::REFLECT_NODE_TYPE);
        let stats = crate::derive::builtin::Stats {
            total_nodes: nodes_by_type.values().sum(),
            total_edges: self.store.edge_count_at(snapshot) as u64,
            nodes_by_type,
        };
        *self.derive_stats_cache.lock().unwrap() =
            Some((snapshot.version, Arc::clone(&snapshot.tombstones), stats.clone()));
        stats
    }

    /// W9 must-fix: invalidate every derive cache that keys on the manifest version
    /// after a SAME-VERSION data mutation. The delete→re-add path
    /// ([`GraphStore::add_nodes`]/[`GraphStore::add_edges`] after a flushed delete of
    /// the same key) calls `ManifestStore::remove_tombstone_nodes`/`_edges`, which
    /// resurrects committed records IN the current version — same version, more
    /// visible data — falsifying "same version ⇒ identical committed data" until the
    /// next flush bumps the version. Three mechanisms rely on that identity:
    ///
    /// * the shared Part-A index cache ([`crate::derive::exec::SharedIndexCaches`]):
    ///   seeds on exact version match and never sees the snapshot's tombstone `Arc`,
    ///   so it must be dropped wholesale here;
    /// * the planner stats cache: self-validating via tombstone-`Arc` identity
    ///   (cleared here as well — the entry can never be served again anyway);
    /// * the unchanged-version short-circuit in [`Self::derive_for_materialize`]:
    ///   self-validating via the same `Arc::ptr_eq` guard (the un-tombstone always
    ///   rebuilds the manifest's tombstone `Arc`), falling through to the maintain
    ///   path, which diffs actual snapshot data and is immune by construction. The
    ///   `derive_materialize_cache` entries therefore stay valid — their pinned
    ///   prior snapshots describe real prior data.
    fn derive_invalidate_same_version_caches(&mut self) {
        *self.derive_stats_cache.lock().unwrap() = None;
        self.derive_shared_indexes.invalidate_all();
    }

    /// Evaluate a **derive-engine** Datalog program over a version-pinned view of this engine and
    /// return the ground tuples derived for `target_predicate`, each as a positional
    /// list of stringified column values (RFD `RFDB_DERIVE_ENGINE` router path, spec P3/I8).
    ///
    /// This is the bridge the server-side kill-switch uses: it captures a
    /// [`crate::storage_v2::read_snapshot::ReadSnapshot`] (pinning the published manifest
    /// version exactly like every other read on this engine, MVCC B5), lends it to a
    /// module-private [`crate::derive::storage_glue::BorrowedLsmStorageView`] (so the
    /// storage type never leaks past `derive`, I10), and routes through the single derive
    /// eval entry [`crate::derive::evaluate`] — there is deliberately no separate
    /// explain fork (I8). The caller maps each positional row onto its head variable
    /// names (the engine does not know the caller's wire shape).
    ///
    /// `events` defaults to the discard sink at this layer; explain capture is a recording
    /// of this same run installed by a future caller, not a second code path.
    pub fn eval_derive(
        &self,
        source: &str,
        target_predicate: &str,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<Vec<Vec<String>>, crate::derive::EvalError> {
        let snapshot = self.snapshot();
        // Compute the planner's relation magnitudes from the SAME pinned snapshot before
        // it moves into the view, so Stats and the eval observe one consistent version.
        // Per-type node counts feed the planner's §7 cardinality oracle so an empty type is
        // estimated at ~0 and placed first (not over-estimated at total_nodes, which trips
        // E-PLAN-003 on rules like beam-* whose node type is absent in this graph). One scan
        // of the pinned snapshot; the eval itself reads more.
        let stats = self.derive_stats(&snapshot);
        let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);
        let evaluation = crate::derive::evaluate_in(
            &view,
            source,
            self.rule_source,
            stats,
            limits,
            crate::derive::events::EventLog::discard(),
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
    /// overlays an in-memory [`crate::derive::storage_glue::OverlayStorageView`] carrying only the
    /// hypothetical edges (their endpoints' attrs resolve from the base), and runs the single v2
    /// eval entry over BOTH base and overlay at the SAME version; the answer is `sim ∖ base`. The
    /// committed store is never touched (read snapshot + in-memory delta, no manifest flip).
    ///
    /// The overlay path is proven sound on the real store
    /// (`derive::differential::…::sim_on_real_store_predicts_new_depends_without_commit`,
    /// `sim ≡ scratch(base ∪ Δ)`). `hypothetical_nodes` are `(id, node_type, name, file)` and
    /// `hypothetical_edges` are `(src, dst, edge_type)`; an edge may reference a hypothetical node
    /// (so sim can add a wholly new import binding, not only bridge existing nodes). A richer wire
    /// API (retract / metadata) can reshape this — it is the internal seam, not a committed contract.
    pub fn sim_derive(
        &self,
        source: &str,
        target_predicate: &str,
        hypothetical_nodes: &[(u128, String, String, String)],
        hypothetical_edges: &[(u128, u128, String)],
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<Vec<Vec<String>>, crate::derive::EvalError> {
        let snapshot = self.snapshot();
        let stats = self.derive_stats(&snapshot);
        let base = crate::derive::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);

        // Base world.
        let base_eval = crate::derive::evaluate_in(
            &base,
            source,
            self.rule_source,
            stats.clone(),
            limits.clone(),
            crate::derive::events::EventLog::discard(),
        )?;
        let base_set: std::collections::HashSet<Vec<String>> = base_eval
            .facts(target_predicate)
            .into_iter()
            .map(|t| t.iter().map(value_to_wire_string).collect::<Vec<String>>())
            .collect();

        // Hypothetical world: overlay the added nodes + edges (existing endpoints' attrs resolve
        // from the base; a hypothetical edge may reference a hypothetical node).
        let mut delta = crate::derive::storage_glue::FixtureStorageView::new(0);
        for (id, node_type, name, file) in hypothetical_nodes {
            delta.put_node(crate::derive::storage_glue::NodeRow {
                id: *id,
                node_type: node_type.clone(),
                name: name.clone(),
                file: file.clone(),
            });
        }
        for (src, dst, ty) in hypothetical_edges {
            delta.put_edge(crate::derive::storage_glue::EdgeRow {
                src: *src,
                dst: *dst,
                edge_type: ty.clone(),
            });
        }
        let overlay = crate::derive::storage_glue::OverlayStorageView::new(&base, delta);
        let sim_eval = crate::derive::evaluate_in(
            &overlay,
            source,
            self.rule_source,
            stats,
            limits,
            crate::derive::events::EventLog::discard(),
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

    /// Evaluate a **derive-engine** Datalog program and write back every `@materialize(edge_type="T")`
    /// predicate's derived facts AS graph edges — the derive `@materialize` write-back path
    /// (Gate B Stage 1).
    ///
    /// # Run isolation + single atomic flip
    ///
    /// The whole run is staged under ONE generation and committed with a SINGLE atomic
    /// manifest flip:
    ///
    /// 1. Capture a version-pinned snapshot (the read generation) and run the single v2
    ///    eval entry ([`crate::derive::evaluate_with_materialize`]) to the fixpoint. The
    ///    target generation is `snapshot.version + 1` — the version the written edges
    ///    become visible at (the orchestrator's `_generation` convention).
    /// 2. Project ALL `@materialize` predicates of the run to one [`EdgeRecordV2`] batch
    ///    and ALL `@materialize_node` predicates to one [`NodeRecordV2`] batch, each
    ///    stamped `{"_source": rule_ast_hash, "_generation": generation}`. Node ids
    ///    derive from the head's semantic-id column by the production convention
    ///    (BLAKE3[0..16] LE); planned nodes whose id ALREADY exists at the snapshot are
    ///    dropped (never rewrite a present node — additive dedup; this path never
    ///    deletes, so node `mode = "exclusive"` retraction lives on the delta path,
    ///    exactly like edge exclusive tombstoning).
    /// 3. Commit the entire batch with a SINGLE [`Self::commit_batch_ext`] (empty
    ///    `changed_files` → additive, no tombstoning of existing data; the underlying
    ///    `commit_batch_ext` flips the manifest exactly once via `commit_edit` — nodes
    ///    and edges land in ONE atomic generation).
    ///
    /// A mid-run failure (parse/stratify/plan/exec/mis-shaped materialized head) returns
    /// the error BEFORE step 3, so nothing is committed and the prior committed generation
    /// stays intact (abort-no-commit). When no rule carries `@materialize` /
    /// `@materialize_node`, the run derives facts and commits nothing.
    ///
    /// Returns the number of edges + nodes written back.
    pub fn eval_derive_materialize(
        &mut self,
        source: &str,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<usize, crate::derive::EvalError> {
        crate::derive::refuse_in_store_mode(self.rule_source, "`@materialize` write-back")?;
        // ── Step 1: pinned snapshot + fixpoint (the read generation). ──
        let snapshot = self.snapshot();
        // The generation the written edges become visible at is one past the pinned read
        // version (the version commit_batch_ext will publish for this run).
        let generation = snapshot.version + 1;

        let stats = self.derive_stats(&snapshot);

        let (evaluation, specs, node_specs) = {
            let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(
                &self.store,
                snapshot.clone(),
            );
            crate::derive::evaluate_with_materialize_shared(
                &view,
                source,
                stats,
                limits,
                crate::derive::events::EventLog::discard(),
                Some(&self.derive_shared_indexes),
            )?
        };

        // ── Step 2: project @materialize → one edge batch, @materialize_node → one node
        // batch. A mis-shaped materialized head aborts here (coded), before any commit.
        let edges =
            crate::derive::materialize::plan_writeback(&specs, &evaluation, generation)?;
        let nodes: Vec<NodeRecordV2> =
            crate::derive::materialize::plan_node_writeback(&node_specs, &evaluation, generation)?
                .into_iter()
                // Never rewrite a node that already exists (additive dedup by id; a
                // foreign producer's node with the same semantic id keeps its metadata).
                .filter(|n| !self.store.node_exists_at(&snapshot, n.id))
                .collect();
        if edges.is_empty() && nodes.is_empty() {
            return Ok(0);
        }
        let written = edges.len() + nodes.len();

        // W9 fix #1: this commit is ADDITIVE (edges of the spec types + brand-new nodes,
        // never a tombstone on this path), so the shared index entries over untouched
        // relations stay valid across the version flip — state the touched set so they
        // carry forward instead of being dropped by the version-key miss.
        let touch = crate::derive::exec::CommitTouch {
            edge_types: specs.iter().map(|s| s.edge_type.clone()).collect(),
            nodes: !nodes.is_empty(),
            edges_unbounded: false,
        };

        // ── Step 3: single atomic commit (one manifest flip). ──
        // Empty `changed_files` ⇒ additive (no tombstoning of existing nodes/edges); the
        // whole run's nodes AND edges land under `generation` with a single `commit_edit`.
        self.commit_batch_ext(nodes, edges, &[], std::collections::HashMap::new(), &[])
            .map_err(|e| {
                crate::derive::EvalError::Materialize(crate::derive::materialize::MaterializeError {
                    code: "E-MAT-004",
                    detail: format!("@materialize write-back commit failed: {e}"),
                })
            })?;
        self.derive_shared_indexes
            .retain_for_commit(snapshot.version, self.snapshot().version, &touch);

        Ok(written)
    }

    /// Incrementally maintain a Datalog program's derived relations against the CURRENT
    /// committed snapshot, given the prior run's result `prev` and the `prev_snapshot` it was
    /// computed at — the real-storage entry behind incremental `@materialize` (spec §9, the
    /// Gate C EXIT on live `storage_v2`).
    ///
    /// Diffs the base relations between the two version-pinned snapshots
    /// ([`crate::derive::increment::diff_base`]) and replays the change through
    /// [`crate::derive::exec::maintain_incremental`] (DRed deletion + insertion). Returns the
    /// maintained [`Evaluation`] — provably equal to a from-scratch eval of the current
    /// snapshot — for the sound monotone envelope, or `Ok(None)` when the program is outside
    /// it (negation / multiple derived strata / ANY `@materialize_node` spec) and the caller
    /// must recompute from scratch. A pure read over the two snapshots: no commit happens
    /// here (projecting the maintained relations back to edges is the write-back caller's
    /// concern).
    ///
    /// Node-materializing programs are categorically OUTSIDE the maintain envelope for now:
    /// the node write-back's provenance-scoped owned-set diff and the potential cross-run
    /// node feedback (a rule reading the node type it materializes) are unproven under a
    /// maintained (delta-seeded) evaluation — scratch is the correctness floor (I5). The
    /// refusal here covers every maintain consumer (the cached production path included).
    pub fn maintain_derive(
        &self,
        source: &str,
        prev: &crate::derive::exec::Evaluation,
        prev_snapshot: crate::storage_v2::read_snapshot::ReadSnapshot,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<Option<crate::derive::exec::Evaluation>, crate::derive::EvalError>
    {
        crate::derive::refuse_in_store_mode(self.rule_source, "maintained (delta-seeded) derivation")?;
        let program = crate::derive::parser_ext::parse_ext_program(source)?;
        if !crate::derive::materialize::collect_materialize_node_specs(&program)?.is_empty() {
            return Ok(None);
        }
        let strat = crate::derive::stratify::stratify(&program)?;
        let rules = program.rules();

        let cur_snapshot = self.snapshot();
        let stats = self.derive_stats(&cur_snapshot);
        let plans = crate::derive::plan::plan_program(&rules, &strat, &stats)?;

        let prev_view =
            crate::derive::storage_glue::BorrowedLsmStorageView::new(&self.store, prev_snapshot);
        let cur_view =
            crate::derive::storage_glue::BorrowedLsmStorageView::new(&self.store, cur_snapshot);
        let base_delta = crate::derive::increment::diff_base(&prev_view, &cur_view);

        let maintained = crate::derive::exec::maintain_incremental::<crate::derive::tag::BoolTag>(
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
        Option<crate::derive::exec::DerivationWitness>,
        crate::derive::EvalError,
    > {
        let snapshot = self.snapshot();
        let stats = self.derive_stats(&snapshot);
        let view =
            crate::derive::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);
        // The program has to be assembled AFTER the view exists: in store mode it is
        // decoded FROM that view, at the same pinned version the explain then reads.
        let (program, _diagnostics) =
            crate::derive::program_for(&view, source, self.rule_source)?;
        let strat = crate::derive::stratify::stratify(&program)?;
        let rules = program.rules();
        let plans = crate::derive::plan::plan_program(&rules, &strat, &stats)?;
        let witness = crate::derive::exec::explain_fact::<crate::derive::tag::BoolTag>(
            &view, &plans, &rules, &strat, predicate, key, limits,
        )?;
        Ok(witness)
    }

    /// why-NOT (`explain_gap`): explain why `predicate(key)` is NOT derived — the unbound
    /// premise that, if supplied, would close the gap (spec §6 coverage). The engine wrapper
    /// for [`crate::derive::exec::explain_gap`], mirroring [`Self::explain_datalog_fact`]
    /// exactly (one pinned snapshot → BorrowedLsmStorageView → full eval + head-bound replay).
    /// `None` when the fact is actually derivable (no gap) or no clause head matches the key.
    /// The companion to [`Self::sim_derive`]: this names the missing premise, sim verifies
    /// that adding it produces the fact.
    pub fn explain_datalog_gap(
        &self,
        source: &str,
        predicate: &str,
        key: &[crate::datalog::Value],
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<
        Option<crate::derive::exec::GapWitness>,
        crate::derive::EvalError,
    > {
        let snapshot = self.snapshot();
        let stats = self.derive_stats(&snapshot);
        let view =
            crate::derive::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);
        // The program has to be assembled AFTER the view exists: in store mode it is
        // decoded FROM that view, at the same pinned version the explain then reads.
        let (program, _diagnostics) =
            crate::derive::program_for(&view, source, self.rule_source)?;
        let strat = crate::derive::stratify::stratify(&program)?;
        let rules = program.rules();
        let plans = crate::derive::plan::plan_program(&rules, &strat, &stats)?;
        let gap = crate::derive::exec::explain_gap::<crate::derive::tag::BoolTag>(
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
    /// `maintain_derive` with a pinned prior snapshot) is the perf half of Gate D. This
    /// commit makes the WRITE incremental; the DERIVE-incremental is the follow-up.
    pub fn eval_derive_materialize_incremental(
        &mut self,
        source: &str,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<(usize, usize), crate::derive::EvalError> {
        crate::derive::refuse_in_store_mode(self.rule_source, "incremental `@materialize` write-back")?;
        // ── Phase 1: derive (full eval) then commit only the edge delta. ──
        let snapshot = self.snapshot();
        let generation = snapshot.version + 1;
        let stats = self.derive_stats(&snapshot);
        let (evaluation, specs, node_specs) = {
            let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(
                &self.store,
                snapshot.clone(),
            );
            crate::derive::evaluate_with_materialize_shared(
                &view,
                source,
                stats,
                limits,
                crate::derive::events::EventLog::discard(),
                Some(&self.derive_shared_indexes),
            )?
        };
        self.materialize_writeback_delta(&evaluation, &specs, &node_specs, &snapshot, generation)
    }

    /// Work-proportional `@materialize` (Gate D2): incrementally MAINTAIN the program's derived
    /// relations against the current snapshot — given the prior run's result `prev` and the
    /// `prev_snapshot` it was computed at — then commit only the resulting edge delta. The
    /// derive is delta-seeded ([`Self::maintain_derive`]); the write is delta-only
    /// ([`Self::materialize_writeback_delta`]). Returns `(added, removed)` edge counts.
    ///
    /// Outside the sound monotone envelope (negation / multiple derived strata) maintenance
    /// returns `None` and this falls back to a full from-scratch evaluation — never a silently
    /// wrong answer (I5). The write-back is byte-identical to the full incremental path; only
    /// how the derived `Evaluation` is produced (maintained vs scratch) differs.
    pub fn eval_derive_maintain_writeback(
        &mut self,
        source: &str,
        prev: &crate::derive::exec::Evaluation,
        prev_snapshot: crate::storage_v2::read_snapshot::ReadSnapshot,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<(usize, usize), crate::derive::EvalError> {
        crate::derive::refuse_in_store_mode(self.rule_source, "maintained `@materialize` write-back")?;
        let snapshot = self.snapshot();
        let generation = snapshot.version + 1;
        // Specs come from a parse alone (no eval needed) — the maintained branch must know the
        // target edge/node types without re-deriving.
        let program = crate::derive::parser_ext::parse_ext_program(source)?;
        let specs = crate::derive::materialize::collect_materialize_specs(&program)?;
        let node_specs = crate::derive::materialize::collect_materialize_node_specs(&program)?;

        let evaluation =
            self.derive_for_materialize(source, Some((prev_snapshot, prev)), &snapshot, limits)?;
        self.materialize_writeback_delta(&evaluation, &specs, &node_specs, &snapshot, generation)
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
    pub fn eval_derive_materialize_cached(
        &mut self,
        source: &str,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<(usize, usize), crate::derive::EvalError> {
        crate::derive::refuse_in_store_mode(self.rule_source, "cached `@materialize` write-back")?;
        let key = Self::derive_program_key(source, self.rule_source);

        let snapshot = self.snapshot();
        let generation = snapshot.version + 1;
        let program = crate::derive::parser_ext::parse_ext_program(source)?;
        let specs = crate::derive::materialize::collect_materialize_specs(&program)?;
        let node_specs = crate::derive::materialize::collect_materialize_node_specs(&program)?;

        // Clone the prior entry out so the `&self` maintain borrow doesn't collide with the
        // `&mut self` write-back; cloning the ReadSnapshot bumps its pin (released on drop).
        // W8 Part 3: a cold-start miss (fresh process, empty in-process cache) consults the
        // durable pin sidecar — an EXACT (version, tombstone-content) match rehydrates the
        // prior evaluation and the derive below takes the unchanged-graph short-circuit
        // instead of a full scratch eval. Any mismatch is a clean miss (scratch, I5).
        let prior_owned = self
            .derive_materialize_cache
            .get(&key)
            .cloned()
            .or_else(|| self.try_rehydrate_durable_pin(key, &snapshot));
        let evaluation = {
            let prior = prior_owned.as_ref().map(|(s, e)| (s.clone(), e));
            self.derive_for_materialize(source, prior, &snapshot, limits)?
        };

        // W8 Part 3 soundness probe, captured BEFORE the write-back mutates anything:
        // the write-back commits via the engine `flush()`, which publishes ALL pending
        // engine state (MVCC B2 visibility=publish) — buffered `add_nodes`/`add_edges`
        // from any connection plus pending tombstones RIDE the commit. Riders can be of
        // any type (including types the program reads, and node facts the disjointness
        // gate never inspects), so a non-empty-delta pin keyed to the post-commit
        // snapshot would silently serve results that never saw them. Riders present ⇒
        // the non-empty-delta persist is refused (see `persist_durable_pin`).
        let riders_pending = self.store.has_buffered_writes()
            || !self.pending_tombstone_nodes.is_empty()
            || !self.pending_tombstone_edges.is_empty();
        let counts =
            self.materialize_writeback_delta(&evaluation, &specs, &node_specs, &snapshot, generation)?;
        // W8 Part 3: persist the durable pin when sound (see `persist_durable_pin`); a
        // non-persistable run REMOVES any stale sidecar instead.
        self.persist_durable_pin(
            key,
            &snapshot,
            &evaluation,
            counts,
            riders_pending,
            &program,
            &specs,
            &node_specs,
        );
        // Refresh the cache to this generation (drops & unpins the previous one).
        self.derive_materialize_cache.insert(key, (snapshot, evaluation));
        Ok(counts)
    }

    /// W8 Part 3: try to rehydrate a durable D2 pin for `key` against the CURRENT snapshot.
    /// Returns a `(prev_snapshot, prev_evaluation)` pair usable by
    /// [`Self::derive_for_materialize`] — the prev snapshot IS a clone of the current one
    /// (same version, same tombstone `Arc`), so the derive takes its unchanged-graph
    /// short-circuit and the rehydrated evaluation is returned verbatim. `None` on any
    /// mismatch (different version, different tombstone content, missing/corrupt file,
    /// ephemeral engine) — the caller then pays scratch, exactly the pre-W8 behavior.
    fn try_rehydrate_durable_pin(
        &self,
        key: u64,
        snapshot: &crate::storage_v2::read_snapshot::ReadSnapshot,
    ) -> Option<(
        crate::storage_v2::read_snapshot::ReadSnapshot,
        crate::derive::exec::Evaluation,
    )> {
        use crate::derive::pin_sidecar;
        let path = self.path.as_ref()?;
        let pin = pin_sidecar::load(path, key)?;
        if pin.version != snapshot.version {
            tracing::info!(
                "derive durable pin MISS for program {key:016x}: stored version {} != current {} — scratch",
                pin.version,
                snapshot.version
            );
            return None;
        }
        if pin.tombstone_hash != pin_sidecar::tombstone_hash(&snapshot.tombstones) {
            // Same version but the tombstone CONTENT differs (the same-version
            // un-tombstone path, W9 lesson) — the visible data is NOT what the pin was
            // computed over. Scratch.
            tracing::info!(
                "derive durable pin MISS for program {key:016x}: tombstone state changed at version {} — scratch",
                snapshot.version
            );
            return None;
        }
        eprintln!(
            "[engine_v2] derive durable pin HIT for program {key:016x} at version {} — \
             rehydrated prior evaluation, skipping scratch",
            snapshot.version
        );
        Some((snapshot.clone(), pin.evaluation))
    }

    /// W8 Part 3: persist the durable D2 pin after a successful cached write-back, when
    /// sound (the full argument lives in the [`crate::derive::pin_sidecar`] module docs):
    ///
    /// * empty write-back delta ⇒ no version flip ⇒ `evaluation == scratch(current)` —
    ///   persist at the pre-eval snapshot's version unconditionally;
    /// * non-empty delta ⇒ persist at the POST-commit version, but only when the
    ///   write-back commit provably published NOTHING beyond the program's own delta
    ///   (`riders_pending == false`: empty store write buffers + empty pending
    ///   tombstones at write-back entry — the engine flush publishes everything
    ///   pending, MVCC B2 visibility=publish) AND the program is edge-only with a
    ///   body that provably never reads the edge types it writes (read/write-disjoint
    ///   ⇒ the fixpoint at the post-commit snapshot is identical);
    /// * otherwise remove any stale sidecar — restart pays scratch (no laundering).
    ///
    /// Persistence failures are logged, never propagated: the sidecar is an optimization,
    /// the in-process cache and the result are already correct.
    #[allow(clippy::too_many_arguments)]
    fn persist_durable_pin(
        &mut self,
        key: u64,
        pre_snapshot: &crate::storage_v2::read_snapshot::ReadSnapshot,
        evaluation: &crate::derive::exec::Evaluation,
        counts: (usize, usize),
        riders_pending: bool,
        program: &crate::derive::parser_ext::ExtProgram,
        specs: &[crate::derive::materialize::MaterializeSpec],
        node_specs: &[crate::derive::materialize::NodeMaterializeSpec],
    ) {
        use crate::derive::pin_sidecar;
        let Some(path) = self.path.clone() else {
            return; // ephemeral engine: nothing durable to pin
        };
        let state = if counts == (0, 0) {
            // No write-back mutation: the pre-eval snapshot IS the current state.
            // (Sound even with riders pending — nothing was flushed, so the pin is
            // keyed to exactly the data the evaluation read; a later rider flush
            // flips the version and the pin cleanly misses.)
            Some((
                pre_snapshot.version,
                pin_sidecar::tombstone_hash(&pre_snapshot.tombstones),
            ))
        } else if !riders_pending
            && node_specs.is_empty()
            && !pin_sidecar::program_reads_written_edge_types(&program.rules(), specs)
        {
            // Rider-free, read/write-disjoint, edge-only program: the commit published
            // EXACTLY the program's own delta, and that delta touches only base facts
            // no rule body observes — the evaluation is also the fixpoint of the
            // post-commit snapshot. Key the pin to THAT state (what a restart sees).
            // With riders the post-commit snapshot would contain data (of arbitrary
            // edge AND node types) the evaluation never saw — refuse, drop the sidecar.
            let cur = self.snapshot();
            Some((cur.version, pin_sidecar::tombstone_hash(&cur.tombstones)))
        } else {
            None
        };
        match state {
            Some((version, hash)) => {
                if let Err(e) = pin_sidecar::save(&path, key, version, &hash, evaluation) {
                    eprintln!(
                        "[engine_v2] derive durable pin save failed for program {key:016x}: {e} \
                         (restart will pay scratch)"
                    );
                }
            }
            None => pin_sidecar::remove(&path, key),
        }
    }

    /// Produce the derived `Evaluation` for a `@materialize` run: MAINTAIN against a prior pinned
    /// `(snapshot, Evaluation)` when one is supplied AND the program stays inside the monotone
    /// envelope; otherwise (no prior, or maintenance returned `None`) recompute from scratch.
    /// Shared by the explicit-prev ([`Self::eval_derive_maintain_writeback`]) and cached
    /// ([`Self::eval_derive_materialize_cached`]) entries.
    fn derive_for_materialize(
        &self,
        source: &str,
        prior: Option<(
            crate::storage_v2::read_snapshot::ReadSnapshot,
            &crate::derive::exec::Evaluation,
        )>,
        cur_snapshot: &crate::storage_v2::read_snapshot::ReadSnapshot,
        limits: crate::datalog::EvalLimits,
    ) -> std::result::Result<crate::derive::exec::Evaluation, crate::derive::EvalError> {
        if let Some((prev_snapshot, prev)) = prior {
            // W9: UNCHANGED-graph short-circuit. Same manifest version + same tombstone
            // `Arc` ⇒ identical committed data ⇒ a fresh evaluation would be
            // byte-identical to the cached one — return it verbatim. Without this, every
            // repeat call against an idle graph paid `diff_base`'s full two-snapshot scan
            // (plus plan/index setup) only to discover an empty delta: measured 188.9s
            // for a second 20-pack sweep vs 80.7s for the first (the maintain legs were
            // SLOWER than warm scratch). Programs outside the maintain envelope
            // (negation, node specs) are equally covered — the equality argument needs
            // no envelope. The version alone is NOT the identity: the delete→re-add
            // path (`add_edges`/`add_nodes` after a flushed delete of the same key)
            // resurrects committed records IN the current version via
            // `remove_tombstone_edges`/`_nodes` — same version, MORE visible data.
            // That mutation always publishes a fresh tombstone `Arc`, so the `ptr_eq`
            // guard sends it down the maintain path below, which diffs the ACTUAL
            // snapshot data (`diff_base`) and derives from the resurrected facts.
            if prev_snapshot.version == cur_snapshot.version
                && Arc::ptr_eq(&prev_snapshot.tombstones, &cur_snapshot.tombstones)
            {
                #[cfg(test)]
                self.derive_unchanged_hits
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return Ok(prev.clone());
            }
            if let Some(e) = self.maintain_derive(source, prev, prev_snapshot, limits.clone())? {
                #[cfg(test)]
                self.derive_maintain_hits
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
    ) -> std::result::Result<crate::derive::exec::Evaluation, crate::derive::EvalError> {
        let stats = self.derive_stats(snapshot);
        let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(
            &self.store,
            snapshot.clone(),
        );
        Ok(crate::derive::evaluate_with_materialize_shared(
            &view,
            source,
            stats,
            limits,
            crate::derive::events::EventLog::discard(),
            Some(&self.derive_shared_indexes),
        )?
        .0)
    }

    /// Commit ONLY the delta of a freshly-derived `@materialize` / `@materialize_node`
    /// result against what is already in the graph: the currently-materialized edges of each
    /// spec's `edge_type` ARE the prior derived edge state (no extra cross-run storage), and
    /// for an EXCLUSIVE node spec the prior owned state is the nodes of its `node_type`
    /// whose `metadata._source` equals that rule's hash (provenance-scoped — never the whole
    /// type; see the materialize module docs for why node exclusive differs from edge
    /// exclusive). Facts new this run are added (buffered); edge facts gone this run are
    /// edge-tombstoned; OWNED nodes not re-derived this run are node-tombstoned. A single
    /// [`Self::flush`] applies ALL additions and tombstones together — nodes and edges in
    /// one manifest advance (run isolation). A mis-shaped materialized head aborts in
    /// [`plan_writeback`] / [`plan_node_writeback`] BEFORE any mutation (abort-no-commit).
    /// Returns `(added, removed)` counts summed over edges + nodes. Shared by the
    /// full-incremental and maintain-incremental `@materialize` entries.
    fn materialize_writeback_delta(
        &mut self,
        evaluation: &crate::derive::exec::Evaluation,
        specs: &[crate::derive::materialize::MaterializeSpec],
        node_specs: &[crate::derive::materialize::NodeMaterializeSpec],
        snapshot: &crate::storage_v2::read_snapshot::ReadSnapshot,
        generation: u64,
    ) -> std::result::Result<(usize, usize), crate::derive::EvalError> {
        use std::collections::HashSet;

        // The full derived edge + node sets (also the abort-no-commit shape checks; BOTH
        // plans run before ANY mutation below, so either rejection commits nothing).
        let new_edges =
            crate::derive::materialize::plan_writeback(specs, evaluation, generation)?;
        let new_nodes =
            crate::derive::materialize::plan_node_writeback(node_specs, evaluation, generation)?;
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

        // ── Node delta. Adds: planned nodes that are genuinely new (id ABSENT at the
        // snapshot), PLUS owned nodes whose surface CHANGED since the last run — an
        // existing OWNED node (this rule's `_source`) whose name/file/meta differs is
        // upserted (the new version supersedes the old on read, newest-segment-wins;
        // [`owned_node_surface_changed`]). A FOREIGN producer's node at the same id is
        // still never rewritten (it keeps its own name/file/metadata), and an unchanged
        // owned node is a no-op. This is the last-write-wins (plugin) contract for a
        // rule's own nodes — without it, a re-derived owned node with a changed surface
        // (e.g. an ISSUE message after a renamed callee) kept its stale payload forever.
        // Removes: per EXCLUSIVE spec, the provenance-scoped owned set (`node_type` ∩
        // `metadata._source == rule_ast_hash`) minus everything derived this run. A node
        // id derived by ANY spec this run is kept, so overlapping specs never flap each
        // other's nodes, and a rewritten owned node (in `new_node_ids`) is upserted, not
        // tombstoned — its edges are preserved.
        let new_node_ids: HashSet<u128> = new_nodes.iter().map(|n| n.id).collect();
        let added_nodes: Vec<NodeRecordV2> = new_nodes
            .into_iter()
            .filter(|n| match self.store.get_node_at(snapshot, n.id) {
                None => true,
                Some(stored) => owned_node_surface_changed(n, &stored),
            })
            .collect();
        // Membership SET, not a Vec: the old `removed_node_ids.contains(&n.id)` dedup
        // guard scanned a growing Vec for EVERY node of the spec's type, so a write-back
        // over a type with K owned nodes did O(K²) comparisons on the hot incremental
        // path (`find_nodes_at` yields all N nodes of the type; each probes the up-to-K
        // already-claimed ids). A `HashSet` makes the probe O(1) → O(N) overall, and its
        // `insert` is inherently idempotent. This mirrors the edge-removal path above,
        // which already dedups via `HashSet`s (`prev_keys`/`new_keys`/`additive_types`);
        // the node path is the only one that had regressed to a linear-scan Vec.
        // Tombstone order is irrelevant — `delete_node` records into a tombstone SET — so
        // dropping insertion order costs nothing.
        let mut removed_node_ids: HashSet<u128> = HashSet::new();
        for spec in node_specs {
            if spec.additive {
                continue; // additive: never delete (the whole point of the mode)
            }
            for n in self
                .store
                .find_nodes_at(snapshot, Some(&spec.node_type), None)
            {
                if new_node_ids.contains(&n.id) || removed_node_ids.contains(&n.id) {
                    continue;
                }
                // Owned iff the stored provenance stamp names THIS rule. A foreign
                // `_source` (another rule, an orchestrator phase, a plugin) — or no
                // metadata at all — is NOT owned and is never tombstoned.
                let owned = serde_json::from_str::<serde_json::Value>(&n.metadata)
                    .ok()
                    .and_then(|m| m.get("_source").and_then(|s| s.as_str().map(String::from)))
                    .is_some_and(|s| s == spec.rule_ast_hash);
                if owned {
                    removed_node_ids.insert(n.id);
                }
            }
        }

        // ── Phase 2: apply the delta (ONE flush commits node+edge adds + tombstones). ──
        let n_added = added.len() + added_nodes.len();
        let n_removed = removed.len() + removed_node_ids.len();
        if n_added == 0 && n_removed == 0 {
            return Ok((0, 0));
        }
        // W9 fix #1: state EXACTLY what this commit touches so the shared index cache can
        // carry untouched entries across the version flip. A node TOMBSTONE cascades edge
        // tombstones of arbitrary types (`delete_node`), so it voids every edge index.
        let touch = crate::derive::exec::CommitTouch {
            edge_types: specs.iter().map(|s| s.edge_type.clone()).collect(),
            nodes: !added_nodes.is_empty() || !removed_node_ids.is_empty(),
            edges_unbounded: !removed_node_ids.is_empty(),
        };
        // W4 #2: stage tombstones + adds with intra-add auto-flush suppressed, so the
        // SINGLE explicit flush() below is the only publish — a buffer-pressure auto-flush
        // inside add_nodes/add_edges would otherwise expose the adds while these tombstones
        // are still engine-side (`pending_tombstone_*`), tearing the "ONE flush" invariant.
        self.with_auto_flush_suppressed(|s| {
            for id in &removed_node_ids {
                s.delete_node(*id);
            }
            for (src, dst, t) in &removed {
                s.delete_edge(*src, *dst, t);
            }
            if !added.is_empty() {
                let v1: Vec<EdgeRecord> = added.iter().map(edge_v2_to_v1).collect();
                s.add_edges(v1, true);
            }
            if !added_nodes.is_empty() {
                let v1: Vec<NodeRecord> = added_nodes.iter().map(node_v2_to_v1).collect();
                s.add_nodes(v1);
            }
        });
        self.flush().map_err(|e| {
            crate::derive::EvalError::Materialize(crate::derive::materialize::MaterializeError {
                code: "E-MAT-005",
                detail: format!("incremental @materialize write-back flush failed: {e}"),
            })
        })?;
        self.derive_shared_indexes
            .retain_for_commit(snapshot.version, self.snapshot().version, &touch);
        Ok((n_added, n_removed))
    }

    /// Drop every engine-level derive cache: the D2 materialize cache (each entry pins a
    /// prior manifest version — dropping releases the pins), the planner-stats cache, and
    /// the W9 shared build-once indexes. Called by clear (the caches are keyed by manifest
    /// version / tombstone-Arc identity, but a clear RESETS the version counter to 1 — a
    /// stale entry could otherwise collide with a future version-1-after-clear snapshot).
    fn reset_derive_caches(&mut self) {
        self.derive_materialize_cache.clear();
        *self.derive_stats_cache.lock().unwrap() = None;
        self.derive_shared_indexes = crate::derive::exec::SharedIndexCaches::new();
    }

    /// Reflect a program's rules INTO this database (Projection T) and return the number
    /// of facts written.
    ///
    /// The write is idempotent: a fact's node id is content-addressed over its canonical
    /// tuple, so reflecting the same program twice hits the same nodes. It is also
    /// ADDITIVE — reflecting a second program adds its rules beside the first. Taking a
    /// rule OUT of force goes through this same door and no other: a program may carry a
    /// `supersedes(<rule id>)` directive beside the rule that replaces it, and the gate in
    /// [`crate::derive::reflect::encode_rules_to_records_beside`] refuses a directive with
    /// no replacement, an unknown victim, or a supersession cycle. The superseded rule is
    /// not removed — it stays in the store and stays decodable
    /// ([`Self::reflected_rule_catalogue`] is where it can be read back).
    ///
    /// The commit passes NO changed files: the reflected nodes live under the virtual file
    /// [`crate::derive::reflect::REFLECT_FILE`], so no re-analysis of a real source file
    /// can tombstone a rule.
    ///
    /// Two things this door REFUSES rather than accepts quietly, because both would show up
    /// later as a wrong answer with no error attached:
    ///
    /// * a program Projection T cannot carry whole — `#requires`, `@materialize` /
    ///   `@materialize_node` annotations, a lattice payload
    ///   ([`crate::derive::reflect::refuse_unreflectable_program`]). Annotations are not
    ///   only a write-back concern: they feed stratification, so a store built by dropping
    ///   them could answer differently from the text it came from;
    /// * a rule id already claimed in this store by a DIFFERENT clause
    ///   ([`crate::derive::reflect::encode_rules_to_records_beside`]). Reflection is
    ///   additive and the id is 32-bit, so a collision would merge two clauses' premises
    ///   into a rule nobody wrote.
    pub fn reflect_program(
        &mut self,
        source: &str,
    ) -> std::result::Result<usize, crate::derive::EvalError> {
        let program = crate::derive::parser_ext::parse_ext_program(source)?;
        crate::derive::reflect::refuse_unreflectable_program(&program)?;
        let rules = program.rules();
        // What this store already claims, read through the same pinned view the executor
        // would use, so the gate sees exactly the rules a decode would.
        let already = {
            let snapshot = self.snapshot();
            let view =
                crate::derive::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);
            crate::derive::reflect::rule_index(&view)
        };
        let records = crate::derive::reflect::encode_rules_to_records_beside(&rules, &already)?;
        let written = records.len();
        self.commit_batch_ext(records, vec![], &[], std::collections::HashMap::new(), &[])
            .map_err(|e| {
                crate::derive::EvalError::Reflect(crate::derive::reflect::ReflectError::mode(
                    format!("reflected commit failed: {e}"),
                ))
            })?;
        // The rules just changed, so every cached derived result keyed to the old program
        // is stale.
        self.reset_derive_caches();
        Ok(written)
    }

    /// The rule catalogue this database carries, decoded: what is IN FORCE, what has been
    /// SUPERSEDED, and every supersession claim that put it there.
    ///
    /// The READ half of «supersede only». The write half is enforced
    /// ([`Self::reflect_program`] holds the gate, and the delete doors on the wire refuse
    /// a rule record), but «the superseded rule stays on record» is only a guarantee if
    /// something can ASK for it. Without this door the record is on disk and out of
    /// reach — a client sees the undecoded blobs of a `queryNodesByFile` and nothing that
    /// says which rule they once were.
    ///
    /// Read-only, over the same pinned view the executor would take, so what it reports is
    /// what a store-mode evaluation would run.
    pub fn reflected_rule_catalogue(&self) -> crate::derive::reflect::DecodedRules {
        let snapshot = self.snapshot();
        let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(&self.store, snapshot);
        crate::derive::reflect::decode_rules(&view)
    }

    /// The cache / durable-pin key of a derive program.
    ///
    /// Hashes the program text TOGETHER with the rule-source mode bit. The mode bit is
    /// load-bearing, not decoration: in store mode the text argument is not the program
    /// (it degenerates, typically to `""`), so a text-only hash would map every store-mode
    /// program onto ONE key — and would also let a text-mode result be served to a
    /// store-mode request on the same source string. The key also names the durable pin
    /// sidecar file, so the same collision would cross process restarts.
    pub(crate) fn derive_program_key(source: &str, mode: crate::derive::RuleSource) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        source.hash(&mut hasher);
        mode.key_bit().hash(&mut hasher);
        hasher.finish()
    }

    /// Where this database's rules come from ([`crate::derive::RuleSource`]).
    pub fn rule_source(&self) -> crate::derive::RuleSource {
        self.rule_source
    }

    /// Change where this database's rules come from, and PERSIST it to `db_config.json`.
    ///
    /// A durable database property, not a per-request switch: flipping it changes what
    /// every subsequent derive call executes, so it has to survive a restart or a reopened
    /// database would silently run the other program. An ephemeral engine has no config
    /// file — the flag is then in-memory only, which is exactly its lifetime.
    ///
    /// ALL-OR-NOTHING against the file: a disk-backed engine whose `db_config.json` write
    /// fails keeps the OLD mode in memory. The earlier order — assign, then persist —
    /// produced exactly the split this flag exists to prevent: memory saying `store` while
    /// the file still said `text`, so the database answered store-mode queries until the
    /// next restart and then silently reverted. Worse, the split laundered itself, because
    /// [`Self::persist_durable_flags`] writes EVERY cached flag: one later successful write
    /// of any other flag would have committed the mode that had already failed to persist.
    /// Pinned by `a_failed_durable_write_leaves_the_rule_source_as_it_was`.
    pub fn set_rule_source(&mut self, mode: crate::derive::RuleSource) -> Result<()> {
        let previous = self.rule_source;
        self.rule_source = mode;
        if let Some(path) = self.path.clone() {
            if let Err(e) = self.persist_durable_flags(&path) {
                self.rule_source = previous;
                return Err(e);
            }
        }
        // Changing the rule source changes the PROGRAM, so every cached derived result and
        // durable pin keyed to the old program is stale by construction. After the write,
        // not before: a rolled-back switch changed no program and must invalidate nothing.
        self.reset_derive_caches();
        Ok(())
    }

    /// Whether this database runs under ROFL rules.
    ///
    /// Read-only by design in this iteration: nothing in the engine branches on it yet.
    pub fn rofl_mode(&self) -> bool {
        self.rofl_mode
    }

    /// Mark this database as running under ROFL rules, and PERSIST the marker to
    /// `db_config.json`.
    ///
    /// One-way on purpose — there is no disabling counterpart. That asymmetry mirrors the
    /// ROFL spec: revision is assert-only, with supersession instead of retraction, so a
    /// database that has entered the mode has no defined exit. Allowing it back off would
    /// mean the state at a tick stopped being a pure function of the rules, the base facts
    /// and the tick log. A database that must leave the mode is rebuilt from sources, not
    /// downgraded in place.
    ///
    /// Idempotent: marking an already-ROFL database rewrites the same content. An ephemeral
    /// engine has no config file, so the marker is in-memory only — exactly that engine's
    /// lifetime.
    ///
    /// ALL-OR-NOTHING against the file, for the same reason as
    /// [`Self::set_rule_source`]: a marker that lives only in memory is not a marker, and
    /// because [`Self::persist_durable_flags`] writes every cached flag at once, an
    /// in-memory-only `true` here would be committed by the next successful write of the
    /// rule source. Pinned by `a_failed_durable_write_leaves_the_rule_source_as_it_was`.
    pub fn enable_rofl_mode(&mut self) -> Result<()> {
        let previous = self.rofl_mode;
        self.rofl_mode = true;
        if let Some(path) = self.path.clone() {
            if let Err(e) = self.persist_durable_flags(&path) {
                self.rofl_mode = previous;
                return Err(e);
            }
        }
        Ok(())
    }

    /// Read-modify-write this database's durable flags into `db_config.json`, preserving
    /// the shard count the file already carries (never re-deriving it from the runtime
    /// profile, which can differ from the value this database was created with).
    ///
    /// Writes EVERY durable flag the engine caches, not only the one a caller just changed:
    /// a helper that persisted one flag would silently drop the others whenever the file it
    /// read was not the one this engine last wrote. Read-modify-WRITE through the atomic
    /// [`crate::storage_v2::multi_shard::DatabaseConfig::write_to`], so a crash mid-call
    /// leaves the previous config whole rather than a half-written one.
    ///
    /// Not what [`Self::clear_durable`] uses: recreating a store and then correcting its
    /// config would be two writes with a demoted database in between. The flags go into
    /// that write directly (`MultiShardStore::create_with_flags`).
    fn persist_durable_flags(&self, path: &Path) -> Result<()> {
        let mut config = crate::storage_v2::multi_shard::DatabaseConfig::read_from(path)?
            .ok_or_else(|| {
                crate::error::GraphError::InvalidFormat("Missing db_config.json".to_string())
            })?;
        config.rule_source = self.rule_source;
        config.rofl_mode = self.rofl_mode;
        config.write_to(path)
    }

    /// W8 Part 2: REAL durable clear — atomically truncate the on-disk database so a
    /// subsequent reload (or a cold restart) sees an EMPTY graph. This is what the wire
    /// `Clear` command runs; `analyze --clear`'s clear → shutdown → reload sequence is no
    /// longer a placebo.
    ///
    /// Procedure (disk-backed engine):
    /// 1. Swap the live store + manifest to ephemeral placeholders — drops every open
    ///    segment handle and manifest Arc the engine holds.
    /// 2. Delete the manifest authority (`current.json`, `manifests/`,
    ///    `manifest_index.json`) and immediately recreate a fresh empty manifest
    ///    (`ManifestStore::create`, durable). After this point a crash leaves a VALID
    ///    empty database: orphaned segment files are unreferenced by the empty manifest
    ///    and invisible to any reader.
    /// 3. Delete the data trees (`segments/`, `gc/`, the derive pin sidecar dir) and
    ///    recreate the shard skeleton (`MultiShardStore::create`).
    /// 4. Reset all in-memory engine state: pending tombstones, declared fields, and the
    ///    derive caches ([`Self::reset_derive_caches`] — the D2 entries pin pre-clear
    ///    manifest versions and MUST be dropped).
    ///
    /// The `LOCK` sentinel is intentionally preserved: it carries the DatabaseManager's
    /// advisory flock for the server process lifetime.
    ///
    /// MVCC semantics (decided, tested): clear runs under the engine's exclusive write
    /// access (`&mut self` — the server wire handler holds the engine write lock), so no
    /// request-scoped reader can span it. The only cross-request pinned snapshots are the
    /// engine-owned D2 materialize cache entries, which are dropped here. Post-clear
    /// readers see an empty graph; nothing observes a torn state. A crash in the tiny
    /// window inside step 2 (authority deleted, fresh manifest not yet written) leaves a
    /// database that fails to open with an explicit error — the documented manual
    /// fallback (`rm -rf <db>.rfdb`) recovers; clear never silently resurrects data.
    ///
    /// Every DURABLE FLAG survives, and survives WITHOUT A WINDOW: step 3 rewrites
    /// `db_config.json` from scratch, so the rule source and the ROFL marker are handed to
    /// that write itself (`MultiShardStore::create_with_flags`) instead of being restored
    /// by a second write afterwards. The difference is a crash point: between a default
    /// config and its correction the database on disk IS an ordinary text-mode database,
    /// and a crash — or an I/O error on the second write — made that permanent. Clearing
    /// the DATA must never change what the database IS, at any instant, not just at the
    /// end. The shard count comes from the same file for the same reason: it describes the
    /// data on disk, not this machine's tuning profile.
    ///
    /// So do the reflected RULES (step 0 lifts them out, step 4 puts them back). The flag
    /// alone is not enough: a store-mode database whose rules were wiped keeps answering,
    /// with an empty program and therefore an empty result — no error, no diagnostic, just
    /// a quietly wrong answer. `clear` is about graph data; the program is not graph data.
    pub fn clear_durable(&mut self) -> Result<()> {
        // ── 0. Lift the reflected RULES out before the data goes. ──
        // `clear` empties the graph; the rules are not graph data, they are the PROGRAM,
        // and they only live in the node space because that is the space the executor can
        // read. Dropping them here would leave a store-mode database in the one state that
        // fails silently: mode still `Store`, program now empty, every query answering an
        // honest-looking empty set. Captured verbatim (same ids, same blobs), re-committed
        // at the end — a clear that keeps the program is idempotent on it.
        let reflected: Vec<crate::storage_v2::types::NodeRecordV2> = {
            let snapshot = self.snapshot();
            self.store.find_nodes_at(
                &snapshot,
                Some(crate::derive::reflect::REFLECT_NODE_TYPE),
                None,
            )
        };

        let Some(path) = self.path.clone() else {
            // Ephemeral engine: the in-memory swap IS the durable clear.
            self.store = MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT);
            self.manifest = std::sync::Mutex::new(ManifestStore::ephemeral());
            self.pending_tombstone_nodes.clear();
            self.pending_tombstone_edges.clear();
            self.declared_fields.clear();
            self.reset_derive_caches();
            if !reflected.is_empty() {
                self.commit_batch_ext(
                    reflected,
                    vec![],
                    &[],
                    std::collections::HashMap::new(),
                    &[],
                )?;
            }
            return Ok(());
        };

        // ── 1. Release the live store/manifest (open handles, descriptor Arcs). ──
        self.store = MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT);
        self.manifest = std::sync::Mutex::new(ManifestStore::ephemeral());
        self.pending_tombstone_nodes.clear();
        self.pending_tombstone_edges.clear();
        self.declared_fields.clear();
        self.reset_derive_caches();

        // ── 2. Reset the manifest authority FIRST (small, fast), then recreate it. ──
        let _ = std::fs::remove_file(path.join("current.json"));
        let _ = std::fs::remove_file(path.join("manifest_index.json"));
        let _ = std::fs::remove_dir_all(path.join("manifests"));
        let fresh_manifest = ManifestStore::create(&path)?;

        // ── 3. Drop the data trees (now orphaned) and recreate the shard skeleton. ──
        // The shard count comes from the FILE, not from this process's tuning profile:
        // it is a property of the data layout on disk that `MultiShardStore::open` reads
        // back, and re-deriving it from `cached_profile` would silently reshard the
        // database whenever the clear runs on a machine with different RAM or cores.
        // Read before the recreate, which overwrites the config.
        let on_disk_shards = crate::storage_v2::multi_shard::DatabaseConfig::read_from(&path)?
            .map(|c| c.shard_count);
        let shard_count = on_disk_shards.unwrap_or(self.cached_profile.shard_count);
        let _ = std::fs::remove_dir_all(path.join("segments"));
        let _ = std::fs::remove_dir_all(path.join("gc"));
        let _ = std::fs::remove_dir_all(path.join(crate::derive::pin_sidecar::SIDECAR_DIR));
        // The durable flags go INTO that first config write. Writing a default config here
        // and correcting it afterwards was a window, not a nicety: between the two writes
        // the database on disk was an ordinary text-mode, non-ROFL database, so a crash
        // there demoted it permanently — and an I/O error on the second write did the same
        // while this engine went on reporting the old flags in memory. One write, one state.
        let fresh_store = MultiShardStore::create_with_flags(
            &path,
            shard_count,
            self.rule_source,
            self.rofl_mode,
        )?;

        self.store = fresh_store;
        self.manifest = std::sync::Mutex::new(fresh_manifest);

        // ── 4. Put the PROGRAM back (step 0). ──
        if !reflected.is_empty() {
            self.commit_batch_ext(
                reflected,
                vec![],
                &[],
                std::collections::HashMap::new(),
                &[],
            )?;
        }
        Ok(())
    }
}

/// Stringify a derive-engine Datalog [`crate::datalog::Value`] for the wire — THE codec,
/// [`crate::datalog::value_to_wire_string`], not a local copy of it.
///
/// This is deliberate rather than incidental. [`GraphEngineV2::eval_derive`] rows become
/// `WireViolation` bindings (`queryDatalog`/`checkGuarantee`) and [`GraphEngineV2::sim_derive`]
/// rows go to the wire verbatim (`simDatalog`), and BOTH are addresses, not just display text:
/// the documented what-if loop (see `sim_derive`) is "a coverage gap names an unbound premise;
/// sim proves a candidate edge closes it", which means feeding a row element back in as an
/// `explainDatalogFact` / `explainDatalogGap` `key`. If this rendered `Int(1)` as `1` while the
/// explain path parsed `1` as `Id(1)`, that round trip would silently name a different fact.
/// One codec on every value-to-text boundary is what makes the loop closed.
fn value_to_wire_string(v: &crate::datalog::Value) -> String {
    crate::datalog::value_to_wire_string(v)
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
        // W9 must-fix: when entries WERE removed, the current version's visible
        // data just changed without a version bump — drop the version-keyed
        // derive caches (same contract as add_edges below).
        if self.manifest.get_mut().unwrap().remove_tombstone_nodes(&readded_ids) {
            self.derive_invalidate_same_version_caches();
        }
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
        // W9 must-fix: when entries WERE removed, snapshots at the SAME manifest
        // version now see MORE data (the old segment record is resurrected), so
        // every version-keyed derive cache must be dropped — otherwise the
        // shared index seed / stats cache / unchanged-version short-circuit
        // would serve pre-resurrection state for this version.
        if self.manifest.get_mut().unwrap().remove_tombstone_edges(&keys) {
            self.derive_invalidate_same_version_caches();
        }
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

        // Seed explicitly requested non-wildcard types with 0 so callers always
        // get a key even when no matching edges exist.
        if let Some(filter) = edge_types {
            for f in filter.iter() {
                if !f.ends_with('*') {
                    counts.entry(f.to_string()).or_insert(0);
                }
            }
        }

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
            // Barrier: force the FULL L0+L1 merge on every shard (fanout = ∞ ⇒
            // always fold into L1), collapsing all bulk L0 into a single L1 run so
            // the published live segment count is bounded. Size-tiered deferral is
            // for the per-commit hot path only (see maybe_auto_compact); here we
            // explicitly want the complete fold before the durable barrier.
            let config = CompactionConfig {
                segment_threshold: 1,
                l1_fanout: f64::INFINITY,
            };
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
        // fanout = ∞ ⇒ always fold L0 into L1 (explicit-compact is a full barrier,
        // never a size-tiered L0-only consolidation).
        let config = CompactionConfig {
            segment_threshold: 1,
            l1_fanout: f64::INFINITY,
        };
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
        // W8 Part 2: clear is DURABLE for a disk-backed engine. The previous behavior
        // (swap to ephemeral, disk untouched) made `analyze --clear` a documented placebo:
        // clear → shutdown → reload resurrected the old on-disk graph (gaps.md 2026-06-09,
        // skill `rfdb-v2-clear-ephemeral-trap`). The trait method cannot return an error;
        // a failed disk truncation falls back to the old ephemeral swap (the session still
        // sees an empty graph) and LOGS loudly — the wire `Clear` handler calls
        // [`Self::clear_durable`] directly and surfaces the error to the client.
        if let Err(e) = self.clear_durable() {
            eprintln!(
                "[engine_v2] DURABLE CLEAR FAILED ({e}); falling back to ephemeral clear — \
                 the on-disk database was NOT fully truncated (manual `rm -rf` required)"
            );
            self.store = MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT);
            self.manifest = std::sync::Mutex::new(ManifestStore::ephemeral());
            self.pending_tombstone_nodes.clear();
            self.pending_tombstone_edges.clear();
            self.declared_fields.clear();
            self.reset_derive_caches();
        }
    }

    fn declare_fields(&mut self, fields: Vec<FieldDecl>) {
        self.declared_fields = fields;
    }

    fn shard_diagnostics(&self) -> Vec<crate::storage_v2::ShardDiagnostics> {
        self.store.shard_diagnostics()
    }

    fn shard_l0_segment_counts(&self) -> Vec<crate::storage_v2::ShardL0Counts> {
        self.store.shard_l0_segment_counts()
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
        //
        // This runs on EVERY commit, so it must be constant time. It reads the
        // cheap counts (two `Vec::len()` per shard) and NOT the full diagnostics
        // snapshot: the latter also computes exact live node/edge counts, which
        // scans and dedups every record in the database, turning a serial bulk
        // load into O(commits x database size). Guarded by
        // `tests/c3_hot_path_no_full_scan.rs`.
        let max_l0 = self
            .store
            .shard_l0_segment_counts()
            .iter()
            .map(|c| c.l0_node_segment_count.max(c.l0_edge_segment_count))
            .max()
            .unwrap_or(0);
        if max_l0 < self.auto_compact_threshold {
            return Ok(());
        }
        // Compact every shard with >= threshold L0 segments. Slow L1 rewrite runs
        // here under exclusive `&mut self` — never holding the manifest mutex
        // across the rewrite (compact() publishes via a short commit at the end).
        // Per-commit hot path: SIZE-TIERED. The default fanout (4.0) defers the
        // O(|L1|) full rewrite while L0 is small relative to L1, consolidating L0
        // among itself instead. This turns the old O(DB)-per-round full L1 rewrite
        // (C3 gap 1: ms/compaction grew 160→917 over 16k→160k nodes) into amortized
        // O(log_fanout(DB)) rewrites of each L1 byte. The end_bulk_load barrier
        // (fanout=∞) still collapses everything into L1 at the end.
        let config = CompactionConfig {
            segment_threshold: self.auto_compact_threshold,
            l1_fanout: self.auto_compact_fanout,
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

    /// Whole-database walks this engine's store has performed since it was
    /// opened — see `storage_v2::FullScanMeter` for the exact metered set.
    ///
    /// The per-commit write path must leave this number untouched; the guard
    /// `tests/c3_hot_path_no_full_scan.rs` asserts exactly that.
    pub fn full_database_scans(&self) -> u64 {
        self.store.full_database_scans()
    }

    /// MVCC C3.a: set the per-shard live-L0 threshold that triggers auto-compaction
    /// during bulk-load. Larger ⇒ compaction fires less often (more amortization of
    /// the O(total) L1 rewrite, at the cost of a higher live-segment ceiling).
    /// Tuning is out of scope (spec §8); the bench uses this to report sensitivity.
    pub fn set_auto_compact_threshold(&mut self, threshold: usize) {
        self.auto_compact_threshold = threshold.max(1);
    }

    /// W7: set the size-tiered fanout used by the per-commit auto-compaction.
    /// `f64::INFINITY` ⇒ legacy always-full-merge (the bench's A/B baseline);
    /// a finite value (default 4.0) defers the O(|L1|) full rewrite while L0 is
    /// small relative to L1. Values `< 1.0` are clamped to 1.0.
    pub fn set_auto_compact_fanout(&mut self, fanout: f64) {
        self.auto_compact_fanout = if fanout.is_nan() || fanout < 1.0 {
            1.0
        } else {
            fanout
        };
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
        // Explicit-compact is a full barrier (fanout = ∞ ⇒ always fold into L1).
        let config = CompactionConfig {
            segment_threshold: 1,
            l1_fanout: f64::INFINITY,
        };
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

        // W4 #2: inert inside an atomic write-back's apply phase — the closing explicit
        // flush() is the sole publish, so the adds and the run's tombstones land together.
        if self.suppress_auto_flush {
            return;
        }

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
        // W4 #2: same atomic-write-back suppression as the node path (see maybe_auto_flush).
        if self.suppress_auto_flush {
            return;
        }
        if self.store.any_shard_needs_flush(usize::MAX, self.cached_profile.write_buffer_byte_limit) {
            if let Err(e) = self.store.flush_all(self.manifest.get_mut().unwrap()) {
                tracing::warn!("auto-flush (edges) failed: {}", e);
            }
        }
    }

    /// W4 #2: run `f` with the buffer-pressure auto-flush hooks suppressed, restoring the
    /// PRIOR flag afterward (re-entrancy safe). Used by the `@materialize` write-back so its
    /// `delete_node`/`add_edges`/`add_nodes` sequence cannot publish a torn intermediate
    /// version mid-delta — only the explicit `flush()` that runs AFTER `f` (outside this
    /// scope) publishes, committing adds and tombstones together. `f` performs the infallible
    /// staging operations; the one fallible step (the flush) is intentionally left outside,
    /// so an early `?`-return can never strand the flag set.
    fn with_auto_flush_suppressed<R>(&mut self, f: impl FnOnce(&mut Self) -> R) -> R {
        let prev = self.suppress_auto_flush;
        self.suppress_auto_flush = true;
        let out = f(self);
        self.suppress_auto_flush = prev;
        out
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
mod wire_value_tests {
    use super::value_to_wire_string;
    use crate::datalog::{wire_string_to_value, TermBlob, Value};
    use std::sync::Arc;

    /// The derive-engine wire (`eval_derive` → `WireViolation`, `sim_derive` → `simDatalog`)
    /// renders through THE codec, so every row element is an address the explain path can read
    /// back — the property `queryDatalog`/`simDatalog` rows need to be usable as
    /// `explainDatalogFact` keys.
    ///
    /// This REPLACES an earlier expectation that pinned the two P1 arms as `BigInt` → bare
    /// decimal and `Term` → `functor(a1,…)`. Those expectations were wrong, and the
    /// `readback_of_the_former_expectation` assertions below are the proof rather than an
    /// assertion of it: the exact texts they demanded are read back by the SAME protocol's
    /// parse direction as a *different value* — the BigInt text as a node `Id`, the term text
    /// as a `Str`. That is precisely the type-loss R-14 removes, so keeping them would have
    /// been pinning the defect. Coverage is strictly wider here, not narrower: both variants
    /// are still exercised, now under round-trip rather than under a fixed byte string.
    #[test]
    fn derive_wire_rows_render_through_the_codec_and_read_back_as_themselves() {
        let big = Value::big_int(1_i128 << 68);
        let term = Value::Term(Arc::new(TermBlob {
            functor: "pair".to_string(),
            args: vec![Value::Str("a".into()), Value::Int(7)].into_boxed_slice(),
        }));

        // ── Why the former expectation was wrong ──
        // `Value::as_str`'s surface is not readable back: these two texts name other values.
        let readback_of_the_former_expectation = [
            (
                "295147905179352825856",
                Value::Id(295_147_905_179_352_825_856),
            ),
            (r#"pair("a",7)"#, Value::Str(r#"pair("a",7)"#.to_string())),
        ];
        for (text, other) in readback_of_the_former_expectation {
            assert_eq!(
                wire_string_to_value(text),
                other,
                "{text:?} names a DIFFERENT value on the read path — it cannot be the wire form"
            );
        }

        // ── What the codec renders instead: round-trippable, for every variant ──
        for v in [
            big,
            term,
            Value::Id(42),
            Value::Str("s".into()),
            Value::Int(-3),
            Value::Float(1.5),
        ] {
            assert_eq!(
                wire_string_to_value(&value_to_wire_string(&v)),
                v,
                "derive row element must survive the wire: {v:?}"
            );
        }

        // The common surfaces stay byte-identical to the pre-codec wire, so ordinary
        // violation bindings (node ids and names) are unchanged.
        assert_eq!(value_to_wire_string(&Value::Id(42)), "42");
        assert_eq!(value_to_wire_string(&Value::Str("s".into())), "s");
        assert_eq!(
            value_to_wire_string(&Value::Str("IMPORTS_FROM".into())),
            "IMPORTS_FROM"
        );
    }
}

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

    // ── W9 fix #1a: version-keyed planner stats ──────────────────────

    /// The cheap columnar `count_nodes_by_type_at` must agree exactly with the
    /// record-materializing scan the old inline stats code used (dedup + tombstone
    /// semantics included), and the version-keyed cache must MISS after a commit
    /// publishes a new version — staleness is structurally impossible.
    #[test]
    fn derive_stats_cheap_count_matches_full_scan_and_is_never_stale() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let n1 = make_v2_node("a.js->FUNCTION->f1", "FUNCTION", "f1", "a.js");
        let n2 = make_v2_node("a.js->FUNCTION->f2", "FUNCTION", "f2", "a.js");
        let n3 = make_v2_node("b.js->CLASS->c1", "CLASS", "c1", "b.js");
        let id2 = n2.id;
        engine
            .commit_batch_ext(vec![n1, n2, n3], vec![], &[], HashMap::new(), &[])
            .expect("commit");

        let snap = engine.snapshot();
        let stats = engine.derive_stats(&snap);
        // Oracle: the full-record scan the old inline stats computation performed.
        let mut oracle: HashMap<String, u64> = HashMap::new();
        for n in engine.store.find_nodes_at(&snap, None, None) {
            *oracle.entry(n.node_type).or_insert(0) += 1;
        }
        assert_eq!(stats.nodes_by_type, oracle);
        assert_eq!(stats.total_nodes, 3);
        // Same version ⇒ served from cache, same value.
        assert_eq!(engine.derive_stats(&snap).nodes_by_type, stats.nodes_by_type);

        // A delete + flush publishes a NEW version: the cache must miss and recount.
        engine.delete_node(id2);
        engine.flush().expect("flush");
        let snap2 = engine.snapshot();
        assert_ne!(snap2.version, snap.version, "the commit must advance the version");
        let stats2 = engine.derive_stats(&snap2);
        let mut oracle2: HashMap<String, u64> = HashMap::new();
        for n in engine.store.find_nodes_at(&snap2, None, None) {
            *oracle2.entry(n.node_type).or_insert(0) += 1;
        }
        assert_eq!(stats2.nodes_by_type, oracle2);
        assert_eq!(stats2.total_nodes, 2, "the tombstoned FUNCTION must not be counted");
        assert_eq!(stats2.nodes_by_type.get("FUNCTION"), Some(&1));
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

    /// `sim_derive` (the engine seam for what-if) predicts the derived facts a hypothetical
    /// edit would create, WITHOUT committing it. Base graph: two MODULEs (a.ts / b.ts) + one
    /// existing function in b.ts, NO import binding in a.ts → depends/2 is empty. sim adds a
    /// wholly NEW import binding in a.ts (hypothetical node) importing the b.ts function
    /// (hypothetical edge), and must predict `depends(m_a, m_b)` while leaving the committed
    /// graph untouched — exercising both hypothetical-node and hypothetical-edge overlay.
    #[test]
    fn sim_derive_predicts_new_depends_without_committing() {
        use crate::datalog::EvalLimits;
        let src = crate::derive::stdlib::DEPENDS_DL;

        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(1, "MODULE", "m_a", "a.ts"),
            make_v1_node(2, "MODULE", "m_b", "b.ts"),
            make_v1_node(20, "FUNCTION", "eb", "b.ts"),
        ]);
        engine.flush().unwrap();

        // Base world: no import binding in a.ts → no module dependency.
        let base = engine.eval_derive(src, "depends", EvalLimits::none()).expect("base eval");
        assert!(base.is_empty(), "no IMPORTS_FROM yet → depends is empty, got {base:?}");

        // sim: what if a NEW import binding in a.ts imported eb (b.ts)? → depends(m_a, m_b).
        let added = engine
            .sim_derive(
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
        let after = engine.eval_derive(src, "depends", EvalLimits::none()).expect("re-eval");
        assert!(after.is_empty(), "sim must NOT commit the hypothetical edit; got {after:?}");
        assert!(!engine.node_exists(99), "the hypothetical node must never reach the committed store");
    }

    /// `explain_datalog_gap` (engine why-NOT) names the unbound premise of a missing fact — the
    /// companion to `sim_derive`. Program: `calls_someone(F) :- node(F,"FUNCTION"),
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
            .eval_derive_materialize(src, crate::datalog::EvalLimits::none())
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
        let parsed = crate::derive::parser_ext::parse_ext_program(src).unwrap();
        let expected_hash =
            crate::derive::materialize::rule_ast_hash(&parsed.items[0].rule);
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

    /// `meta(...)` projection through the REAL write-back path (the meta twin of
    /// [`materialize_writeback_produces_edges_with_provenance`]): a 4-ary head
    /// `dep(X, Y, NX, NY)` with `meta(src_name, dst_name)` writes ONE edge whose metadata
    /// carries the provenance stamp PLUS the two projected head columns; and the
    /// `(src, dst, edge_type)` diff identity ignores meta — a second run is a no-op.
    #[test]
    fn materialize_writeback_meta_projects_head_columns_into_edge_metadata() {
        let mut engine = GraphEngineV2::create_ephemeral();

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
        let gen = engine.snapshot().version + 1;

        let src = r#"@materialize(edge_type = "DEPENDS_ON", meta(src_name, dst_name))
                     dep(X, Y, NX, NY) :- edge(X, Y, "IMPORTS_FROM"),
                                          attr(X, "name", NX), attr(Y, "name", NY)."#;
        let written = engine
            .eval_derive_materialize(src, crate::datalog::EvalLimits::none())
            .expect("write-back");
        assert_eq!(written, 1, "one IMPORTS_FROM → one DEPENDS_ON edge");

        let snap = engine.snapshot();
        let deps = engine.store.get_edges_by_type_at(&snap, "DEPENDS_ON");
        assert_eq!(deps.len(), 1);
        assert_eq!((deps[0].src, deps[0].dst), (id_a, id_b));

        // Metadata = provenance + the two meta fields (string surfaces of head cols 2/3).
        let meta: serde_json::Value =
            serde_json::from_str(&deps[0].metadata).expect("metadata is JSON");
        let parsed = crate::derive::parser_ext::parse_ext_program(src).unwrap();
        let expected_hash =
            crate::derive::materialize::rule_ast_hash(&parsed.items[0].rule);
        assert_eq!(meta["_source"], serde_json::Value::String(expected_hash));
        assert_eq!(meta["_generation"], serde_json::json!(gen));
        assert_eq!(meta["src_name"], serde_json::json!("a"));
        assert_eq!(meta["dst_name"], serde_json::json!("b"));

        // Identity stays (src, dst, edge_type): re-running the SAME program through the
        // delta write-back adds/removes nothing — the existing edge is not rewritten for
        // meta, and exactly one DEPENDS_ON edge remains.
        let (added, removed) = engine
            .eval_derive_materialize_incremental(src, crate::datalog::EvalLimits::none())
            .expect("incremental re-run");
        assert_eq!((added, removed), (0, 0), "meta does not change edge identity");
        let snap2 = engine.snapshot();
        assert_eq!(engine.store.get_edges_by_type_at(&snap2, "DEPENDS_ON").len(), 1);
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
            .eval_derive_materialize_incremental(src, crate::datalog::EvalLimits::none())
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
            .eval_derive_materialize_incremental(src, crate::datalog::EvalLimits::none())
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
            .eval_derive_materialize_incremental(src_owned, crate::datalog::EvalLimits::none())
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
            .eval_derive_materialize(src, crate::datalog::EvalLimits::none())
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

    // ── @materialize_node write-back ──────────────────────────────────

    /// The node-program every `@materialize_node` engine test shares: one ISSUE node per
    /// FUNCTION, semantic id `issue::fn::<decimal node id>` (concat over the bound id's
    /// decimal surface), name = the function's name, file = its file, `meta(fname)`.
    const NODE_PROG: &str = r#"@materialize_node(node_type = "ISSUE", mode = "exclusive", meta(fname))
        issue(Sid, Name, File, Name) :- node(X, "FUNCTION"), attr(X, "name", Name),
                                        attr(X, "file", File), concat("issue::fn::", X, Sid)."#;

    /// The provenance `_source` hash of [`NODE_PROG`]'s rule.
    fn node_prog_hash() -> String {
        let prog = crate::derive::parser_ext::parse_ext_program(NODE_PROG).unwrap();
        crate::derive::materialize::rule_ast_hash(&prog.items[0].rule)
    }

    /// Plain-path node write-back: a `@materialize_node` rule creates the node with the
    /// PRODUCTION id derivation (BLAKE3(semantic_id)[0..16] LE), the provenance stamp +
    /// meta fields, in ONE atomic generation; a re-run adds nothing (dedup by id) and
    /// never rewrites the existing node.
    #[test]
    fn materialize_node_writeback_creates_nodes_with_production_ids() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let f = make_v2_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js");
        let fid = f.id;
        engine
            .commit_batch_ext(vec![f], Vec::new(), &["a.js".to_string()], HashMap::new(), &[])
            .expect("base commit");
        let version_before = engine.snapshot().version;
        let gen = version_before + 1;

        let written = engine
            .eval_derive_materialize(NODE_PROG, crate::datalog::EvalLimits::none())
            .expect("node write-back");
        assert_eq!(written, 1, "one FUNCTION → one ISSUE node");
        assert_eq!(
            engine.snapshot().version,
            version_before + 1,
            "single atomic generation (one manifest flip)"
        );

        // The node landed under the production id convention.
        let sid = format!("issue::fn::{fid}");
        let expected_id = crate::graph::string_id_to_u128(&sid);
        let snap = engine.snapshot();
        let n = engine
            .store
            .get_node_at(&snap, expected_id)
            .expect("ISSUE node exists at BLAKE3(semantic_id)[0..16] LE");
        assert_eq!(n.semantic_id, sid);
        assert_eq!(n.node_type, "ISSUE");
        assert_eq!(n.name, "f");
        assert_eq!(n.file, "a.js");
        let meta: serde_json::Value = serde_json::from_str(&n.metadata).expect("JSON");
        assert_eq!(meta["_source"], serde_json::Value::String(node_prog_hash()));
        assert_eq!(meta["_generation"], serde_json::json!(gen));
        assert_eq!(meta["fname"], serde_json::json!("f"));

        // Re-run (plain path): the node already exists → nothing written, no new flip.
        let v2 = engine.snapshot().version;
        let written2 = engine
            .eval_derive_materialize(NODE_PROG, crate::datalog::EvalLimits::none())
            .expect("re-run");
        assert_eq!(written2, 0, "additive dedup: an existing id is never re-added");
        assert_eq!(engine.snapshot().version, v2, "a no-op run commits nothing");
    }

    /// Node `mode = "exclusive"` is PROVENANCE-SCOPED: the retraction set is
    /// `node_type` ∩ `metadata._source == this rule's hash` — a planted FOREIGN ISSUE
    /// node (different `_source`, the orchestrator-diagnostics shape) survives every
    /// run untouched, while an owned-stale node (this rule's `_source`, no longer
    /// derived) is tombstoned; and when the deriving base fact disappears, the derived
    /// node retracts too — still without touching the foreign node.
    #[test]
    fn materialize_node_exclusive_retraction_is_provenance_scoped() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let hash = node_prog_hash();

        let f = make_v2_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js");
        let fid = f.id;
        // FOREIGN ISSUE node: same type, a different producer's _source. MUST survive.
        let mut foreign = make_v2_node("issue::orchestrator::1", "ISSUE", "diag", "b.js");
        foreign.metadata = r#"{"_source":"orchestrator-diagnostics","severity":"warning"}"#.to_string();
        let foreign_id = foreign.id;
        let foreign_meta = foreign.metadata.clone();
        // OWNED-STALE ISSUE node: THIS rule's _source, but its semantic id is not derived
        // by the current run. MUST be tombstoned.
        let mut stale = make_v2_node("issue::fn::999", "ISSUE", "gone", "c.js");
        stale.metadata = format!(r#"{{"_source":"{hash}","_generation":1}}"#);
        let stale_id = stale.id;
        engine
            .commit_batch_ext(
                vec![f, foreign, stale],
                Vec::new(),
                &["a.js".to_string(), "b.js".to_string(), "c.js".to_string()],
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        // Run 1: adds the derived ISSUE (for f), removes the owned-stale; foreign intact.
        let (added, removed) = engine
            .eval_derive_materialize_incremental(NODE_PROG, crate::datalog::EvalLimits::none())
            .expect("exclusive write-back");
        assert_eq!((added, removed), (1, 1), "one derived node added, one owned-stale tombstoned");
        let snap = engine.snapshot();
        let derived_id = crate::graph::string_id_to_u128(&format!("issue::fn::{fid}"));
        assert!(engine.store.node_exists_at(&snap, derived_id), "derived ISSUE exists");
        assert!(!engine.store.node_exists_at(&snap, stale_id), "owned-stale retracted");
        let foreign_node = engine
            .store
            .get_node_at(&snap, foreign_id)
            .expect("foreign ISSUE survives a provenance-scoped exclusive run");
        assert_eq!(foreign_node.metadata, foreign_meta, "foreign node not rewritten");

        // Run 2 (no base change): a no-op — the derived node is owned AND re-derived.
        let (a2, r2) = engine
            .eval_derive_materialize_incremental(NODE_PROG, crate::datalog::EvalLimits::none())
            .expect("idempotent re-run");
        assert_eq!((a2, r2), (0, 0));

        // Remove the deriving FUNCTION → its ISSUE retracts; foreign STILL intact.
        engine.delete_node(fid);
        engine.flush().expect("flush deletion");
        let (a3, r3) = engine
            .eval_derive_materialize_incremental(NODE_PROG, crate::datalog::EvalLimits::none())
            .expect("retraction run");
        assert_eq!((a3, r3), (0, 1), "the no-longer-derived owned node retracts");
        let snap3 = engine.snapshot();
        assert!(!engine.store.node_exists_at(&snap3, derived_id));
        assert!(
            engine.store.node_exists_at(&snap3, foreign_id),
            "foreign ISSUE survives the retraction run too"
        );
    }

    /// W4 #2 regression: the `@materialize` write-back is ATOMIC even under write-buffer
    /// pressure. `materialize_writeback_delta` tombstones the owned-stale set then adds the
    /// derived nodes, relying on a SINGLE final flush to publish both together (its own
    /// docstring: "ONE flush commits node+edge adds + tombstones"). But `add_nodes` ends in
    /// `maybe_auto_flush`, which calls `store.flush_all` — and the run's tombstones live in
    /// the engine's `pending_tombstone_*`, which `flush_all` never touches. So under buffer
    /// pressure the auto-flush inside `add_nodes` published a manifest version exposing the
    /// new node while the owned-stale node was NOT yet retracted: a reader pinning that
    /// intermediate version saw a torn state (the add without the matching retraction).
    ///
    /// Observable proxy for the tear: the number of manifest flips. An atomic write-back
    /// advances the version EXACTLY ONCE; a torn one advances it twice (the intra-add
    /// auto-flush, then the tombstone-applying final flush) — and that first extra version
    /// IS the torn intermediate, by construction the only thing committed between the two
    /// flips is "add without tombstone". So `== version_before + 1` is the atomicity invariant.
    #[test]
    fn materialize_writeback_is_atomic_under_buffer_pressure() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let hash = node_prog_hash();

        let f = make_v2_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js");
        let fid = f.id;
        // OWNED-STALE ISSUE node (this rule's `_source`, not derived this run) → the
        // write-back must tombstone it. Pairing an add (for `f`) with this retraction is
        // exactly the shape that tears under an intra-add auto-flush.
        let mut stale = make_v2_node("issue::fn::999", "ISSUE", "gone", "c.js");
        stale.metadata = format!(r#"{{"_source":"{hash}","_generation":1}}"#);
        let stale_id = stale.id;
        engine
            .commit_batch_ext(
                vec![f, stale],
                Vec::new(),
                &["a.js".to_string(), "c.js".to_string()],
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        // Force the node-count auto-flush to fire as soon as ONE node is staged
        // (`exceeds_limits` uses `>=`). Pinning `last_resource_check` to now keeps
        // `maybe_auto_flush`'s 1s-rate-limited re-detection from overwriting the injected
        // profile mid-call.
        engine.cached_profile.write_buffer_node_limit = 1;
        engine.last_resource_check = std::time::Instant::now();

        let version_before = engine.snapshot().version;
        let (added, removed) = engine
            .eval_derive_materialize_incremental(NODE_PROG, crate::datalog::EvalLimits::none())
            .expect("write-back");
        assert_eq!(
            (added, removed),
            (1, 1),
            "one ISSUE added (for f), one owned-stale ISSUE tombstoned"
        );

        assert_eq!(
            engine.snapshot().version,
            version_before + 1,
            "write-back must publish EXACTLY ONE manifest version (atomic; no torn \
             intermediate exposing the add before the retraction)"
        );

        // Final state is correct regardless (the bug tore only the INTERMEDIATE view).
        let snap = engine.snapshot();
        let derived_id = crate::graph::string_id_to_u128(&format!("issue::fn::{fid}"));
        assert!(
            engine.store.node_exists_at(&snap, derived_id),
            "derived ISSUE present in the committed state"
        );
        assert!(
            !engine.store.node_exists_at(&snap, stale_id),
            "owned-stale ISSUE retracted in the committed state"
        );
    }

    /// Node + edge write-back of ONE program commit in the SAME single flush (one
    /// atomic generation): one run, exactly one manifest advance, both the
    /// `@materialize` edge and the `@materialize_node` node visible after it.
    #[test]
    fn materialize_node_and_edge_writeback_share_one_flush() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let a = make_v2_node("a.js->FUNCTION->fa", "FUNCTION", "fa", "a.js");
        let b = make_v2_node("b.js->FUNCTION->fb", "FUNCTION", "fb", "b.js");
        let (id_a, id_b) = (a.id, b.id);
        let link = EdgeRecordV2 {
            src: id_a,
            dst: id_b,
            edge_type: "LINKS".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                vec![a, b],
                vec![link],
                &["a.js".to_string(), "b.js".to_string()],
                HashMap::new(),
                &[],
            )
            .expect("base commit");
        let version_before = engine.snapshot().version;

        let src = r#"@materialize(edge_type = "DERIVED_E")
            e(X, Y) :- edge(X, Y, "LINKS").
            @materialize_node(node_type = "NOTE")
            n(Sid, Name, File) :- node(X, "FUNCTION"), attr(X, "name", Name),
                                  attr(X, "file", File), concat("note::", X, Sid)."#;
        let (added, removed) = engine
            .eval_derive_materialize_incremental(src, crate::datalog::EvalLimits::none())
            .expect("mixed write-back");
        assert_eq!((added, removed), (3, 0), "1 edge + 2 nodes added, nothing removed");
        assert_eq!(
            engine.snapshot().version,
            version_before + 1,
            "nodes and edges commit in ONE flush (one manifest advance)"
        );
        let snap = engine.snapshot();
        assert_eq!(engine.store.get_edges_by_type_at(&snap, "DERIVED_E").len(), 1);
        assert!(engine
            .store
            .node_exists_at(&snap, crate::graph::string_id_to_u128(&format!("note::{id_a}"))));
        assert!(engine
            .store
            .node_exists_at(&snap, crate::graph::string_id_to_u128(&format!("note::{id_b}"))));
    }

    /// W4 review follow-up #5 (`_ai/gaps.md`): an OWNED `@materialize_node` node whose
    /// user-visible surface changes between runs — same derived id, different `name`/meta
    /// (the recorded example: an ISSUE message after a renamed callee) — must be REWRITTEN
    /// to the fresh surface (last-write-wins, the plugin contract), not left stale forever.
    /// A re-run with NO surface change stays a true idempotent no-op.
    ///
    /// The bug is CROSS-FILE by nature: the ISSUE is anchored to file `a.js` (whose nodes
    /// are NOT re-committed), while its `msg` meta column is the name of a FUNCTION in
    /// `b.js` that gets renamed (only `b.js` is in `changed_files`). So file-level cleanup
    /// never touches the stale ISSUE — only the materialize write-back can refresh it.
    #[test]
    fn materialize_node_rewrites_owned_node_when_surface_changes() {
        // The ISSUE is anchored to the `a.js` FUNCTION (stable id + file), its `msg`
        // surface is the `b.js` FUNCTION's name. Renaming `b.js`'s function changes the
        // derived `msg` without re-committing `a.js`.
        const PROG: &str = r#"@materialize_node(node_type = "ISSUE", mode = "exclusive", meta(msg))
            issue(Sid, Aname, Afile, Msg) :-
                node(A, "FUNCTION"), attr(A, "file", "a.js"), attr(A, "name", Aname),
                attr(A, "file", Afile), node(B, "FUNCTION"), attr(B, "file", "b.js"),
                attr(B, "name", Msg), concat("issue::fn::", A, Sid)."#;
        let prog_hash = {
            let parsed = crate::derive::parser_ext::parse_ext_program(PROG).unwrap();
            crate::derive::materialize::rule_ast_hash(&parsed.items[0].rule)
        };

        let mut engine = GraphEngineV2::create_ephemeral();
        let anchor = make_v2_node("a.js->FUNCTION->anchor", "FUNCTION", "anchor", "a.js");
        let aid = anchor.id;
        let callee1 = make_v2_node("b.js->FUNCTION->callee", "FUNCTION", "v1", "b.js");
        let bid = callee1.id;
        engine
            .commit_batch_ext(
                vec![anchor, callee1],
                Vec::new(),
                &["a.js".to_string(), "b.js".to_string()],
                HashMap::new(),
                &[],
            )
            .expect("base commit");

        // Run 1: derive the ISSUE — its `msg` meta surface = the callee name "v1".
        let (a1, _r1) = engine
            .eval_derive_materialize_incremental(PROG, crate::datalog::EvalLimits::none())
            .expect("first derivation");
        assert_eq!(a1, 1, "exactly one ISSUE derived (one a.js × one b.js FUNCTION)");
        let issue_id = crate::graph::string_id_to_u128(&format!("issue::fn::{aid}"));
        {
            let snap = engine.snapshot();
            let n = engine.store.get_node_at(&snap, issue_id).expect("ISSUE exists");
            assert_eq!(n.file, "a.js", "ISSUE anchored to a.js, NOT b.js");
            let meta: serde_json::Value = serde_json::from_str(&n.metadata).unwrap();
            assert_eq!(meta["_source"], serde_json::Value::String(prog_hash.clone()));
            assert_eq!(meta["msg"], serde_json::json!("v1"));
        }

        // Rename the b.js callee in place: SAME semantic id, new `name`. Only `b.js` is in
        // changed_files, so the ISSUE (file a.js) is NOT swept by file-level cleanup — the
        // only thing that can refresh it is the materialize write-back.
        let callee2 = make_v2_node("b.js->FUNCTION->callee", "FUNCTION", "v2", "b.js");
        assert_eq!(callee2.id, bid, "rename keeps the callee node id");
        engine
            .commit_batch_ext(vec![callee2], Vec::new(), &["b.js".to_string()], HashMap::new(), &[])
            .expect("rename commit");
        assert!(
            engine.store.node_exists_at(&engine.snapshot(), issue_id),
            "stale ISSUE survives the b.js-only commit (different file) — this is the bug surface"
        );

        // Run 2: the derived ISSUE id is unchanged but its `msg` surface changed → REWRITE.
        let (a2, r2) = engine
            .eval_derive_materialize_incremental(PROG, crate::datalog::EvalLimits::none())
            .expect("rewrite run");
        {
            let snap = engine.snapshot();
            let n = engine.store.get_node_at(&snap, issue_id).expect("ISSUE still exists");
            let meta: serde_json::Value = serde_json::from_str(&n.metadata).unwrap();
            assert_eq!(
                meta["msg"],
                serde_json::json!("v2"),
                "owned node meta rewritten to the fresh surface (was stale 'v1')"
            );
        }
        assert_eq!(
            (a2, r2),
            (1, 0),
            "one owned node rewritten (upsert add), nothing tombstoned"
        );

        // Run 3: no surface change → idempotent no-op (no churn rewrite, no new flip).
        let v_before = engine.snapshot().version;
        let (a3, r3) = engine
            .eval_derive_materialize_incremental(PROG, crate::datalog::EvalLimits::none())
            .expect("idempotent re-run");
        assert_eq!((a3, r3), (0, 0), "unchanged surface is a true no-op");
        assert_eq!(engine.snapshot().version, v_before, "a no-op run commits nothing");
    }

    /// W4 review follow-up #4 (`_ai/gaps.md`): the owned-node retraction loop in
    /// `materialize_writeback_delta` dedups claimed ids through a SET, so a write-back
    /// over a `node_type` with K owned nodes tombstones each exactly once in O(N) — not
    /// O(N×K) by re-scanning a growing `Vec`. This characterizes the removal-COUNT
    /// invariant the set must preserve (behavior is identical to the prior Vec; the swap
    /// is a perf refactor): with several owned nodes, a run that derives NOTHING retracts
    /// every one of them exactly once (`n_removed == count`, never doubled, never dropped).
    #[test]
    fn materialize_node_retraction_tombstones_each_owned_node_exactly_once() {
        const PROG: &str = r#"@materialize_node(node_type = "ISSUE", mode = "exclusive")
            issue(Sid, Name, File) :- node(X, "FUNCTION"), attr(X, "name", Name),
                                      attr(X, "file", File), concat("issue::", X, Sid)."#;

        let mut engine = GraphEngineV2::create_ephemeral();
        // Several FUNCTION nodes of the SAME materialized type → several owned ISSUEs.
        let fns: Vec<NodeRecordV2> = (0..5)
            .map(|i| {
                make_v2_node(&format!("a.js->FUNCTION->f{i}"), "FUNCTION", &format!("f{i}"), "a.js")
            })
            .collect();
        let fn_ids: Vec<u128> = fns.iter().map(|n| n.id).collect();
        engine
            .commit_batch_ext(fns, Vec::new(), &["a.js".to_string()], HashMap::new(), &[])
            .expect("base commit");

        // Run 1: derive one owned ISSUE per FUNCTION.
        let (a1, r1) = engine
            .eval_derive_materialize_incremental(PROG, crate::datalog::EvalLimits::none())
            .expect("first derivation");
        assert_eq!((a1, r1), (5, 0), "one ISSUE per FUNCTION derived, nothing removed");

        // Remove every deriving FUNCTION → the program now derives ZERO ISSUEs, so every
        // owned ISSUE must retract. This drives the changed retraction loop with K=5 owned
        // nodes of the type.
        for id in &fn_ids {
            engine.delete_node(*id);
        }
        engine.flush().expect("flush deletions");

        // Run 2: nothing derived; each of the 5 owned ISSUEs is tombstoned EXACTLY once.
        let (a2, r2) = engine
            .eval_derive_materialize_incremental(PROG, crate::datalog::EvalLimits::none())
            .expect("retraction run");
        assert_eq!(
            (a2, r2),
            (0, 5),
            "all 5 owned ISSUEs retract, each counted once (no double-tombstone, none dropped)"
        );
        let snap = engine.snapshot();
        for id in &fn_ids {
            let issue_id = crate::graph::string_id_to_u128(&format!("issue::{id}"));
            assert!(
                !engine.store.node_exists_at(&snap, issue_id),
                "owned ISSUE retracted"
            );
        }

        // Run 3: idempotent no-op (nothing left to add or remove).
        let (a3, r3) = engine
            .eval_derive_materialize_incremental(PROG, crate::datalog::EvalLimits::none())
            .expect("idempotent re-run");
        assert_eq!((a3, r3), (0, 0), "nothing left to retract");
    }

    /// A `@materialize_node` head whose arity is not `3 + len(meta)` aborts the run with
    /// the coded `E-MAT-009` BEFORE any mutation — abort-no-commit on both write paths.
    #[test]
    fn materialize_node_arity_mismatch_aborts_no_commit() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let f = make_v2_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js");
        engine
            .commit_batch_ext(vec![f], Vec::new(), &["a.js".to_string()], HashMap::new(), &[])
            .expect("base commit");
        let version_before = engine.snapshot().version;

        // Arity 2 head (semantic id + name, file missing) under @materialize_node.
        let src = r#"@materialize_node(node_type = "ISSUE")
            bad(Sid, Name) :- node(X, "FUNCTION"), attr(X, "name", Name), concat("i::", X, Sid)."#;

        let err = engine
            .eval_derive_materialize(src, crate::datalog::EvalLimits::none())
            .expect_err("arity 2 ≠ 3 must abort (plain path)");
        assert_eq!(err.code(), "E-MAT-009");
        let err = engine
            .eval_derive_materialize_incremental(src, crate::datalog::EvalLimits::none())
            .expect_err("arity 2 ≠ 3 must abort (delta path)");
        assert_eq!(err.code(), "E-MAT-009");

        assert_eq!(
            engine.snapshot().version,
            version_before,
            "abort-no-commit: the prior generation is intact on both paths"
        );
        assert!(engine
            .store
            .find_nodes_at(&engine.snapshot(), Some("ISSUE"), None)
            .is_empty());
    }

    /// A program containing ANY `@materialize_node` spec is OUTSIDE the D2 maintain
    /// envelope: `maintain_derive` refuses (`Ok(None)`), and the cached production
    /// path keeps working through the from-scratch correctness floor (zero maintain
    /// hits across repeat runs, results still exact).
    #[test]
    fn materialize_node_program_is_outside_maintain_envelope() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let f = make_v2_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js");
        let fid = f.id;
        engine
            .commit_batch_ext(vec![f], Vec::new(), &["a.js".to_string()], HashMap::new(), &[])
            .expect("base commit");

        // Direct refusal: the maintain entry returns None before touching prev.
        let prev = crate::derive::exec::Evaluation::default();
        let prev_snapshot = engine.snapshot();
        let out = engine
            .maintain_derive(NODE_PROG, &prev, prev_snapshot, crate::datalog::EvalLimits::none())
            .expect("no error");
        assert!(out.is_none(), "node-materializing program → maintain refusal (scratch floor)");

        // Production cached path: both runs derive from scratch (no maintain hit), the
        // write-back still works and the 2nd run is the exact no-op.
        let (a1, r1) = engine
            .eval_derive_materialize_cached(NODE_PROG, crate::datalog::EvalLimits::none())
            .expect("cached run 1");
        assert_eq!((a1, r1), (1, 0));
        let (a2, r2) = engine
            .eval_derive_materialize_cached(NODE_PROG, crate::datalog::EvalLimits::none())
            .expect("cached run 2");
        assert_eq!((a2, r2), (0, 0));
        assert_eq!(
            engine
                .derive_maintain_hits
                .load(std::sync::atomic::Ordering::Relaxed),
            0,
            "a node-materializing program must never take the maintain path"
        );
        let snap = engine.snapshot();
        assert!(engine
            .store
            .node_exists_at(&snap, crate::graph::string_id_to_u128(&format!("issue::fn::{fid}"))));
    }

    // ── Gate C EXIT on real storage: maintain_derive ≡ scratch ───

    /// The Gate C EXIT on a live `storage_v2` graph (not the in-memory fixture): across a
    /// series of base-edge insertions committed to the real store, the relation maintained by
    /// `maintain_derive` (diff two pinned `ReadSnapshot`s → `maintain_incremental`) is
    /// byte-identical to a from-scratch evaluation of each new snapshot. DRed deletion is
    /// proven on the in-memory fixture across the same `StorageView` trait boundary; this test
    /// exercises the real `BorrowedLsmStorageView` end of it.
    #[test]
    fn maintain_derive_equals_scratch_on_real_store_over_cycles() {
        use crate::derive::exec::{Evaluation, Executor, DEFAULT_ITERATION_CAP};
        use crate::derive::parser_ext::parse_ext_program;
        use crate::derive::plan::plan_program;
        use crate::derive::stratify::stratify;
        use crate::derive::tag::BoolTag;
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
        let stats = crate::derive::builtin::Stats {
            total_nodes: 8,
            total_edges: 8,
            ..Default::default()
        };
        let plans = plan_program(&rules, &strat, &stats).expect("plan");
        let scratch_at = |engine: &GraphEngineV2| -> Evaluation {
            let snap = engine.snapshot();
            let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
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
                .maintain_derive(src, &prev_eval, prev_snap.clone(), EvalLimits::none())
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
            engine.eval_derive_materialize_incremental(src, EvalLimits::none()).unwrap(),
            (2, 0)
        );
        assert_eq!(deps(&engine), [(ia, ib), (ib, ic)].into_iter().collect());

        // Add IMPORTS_FROM c→a → exactly one DEPENDS_ON added, nothing rewritten.
        engine
            .commit_batch_ext(Vec::new(), vec![imp(ic, ia)], &[], HashMap::new(), &[])
            .expect("add edge");
        assert_eq!(
            engine.eval_derive_materialize_incremental(src, EvalLimits::none()).unwrap(),
            (1, 0)
        );
        assert_eq!(deps(&engine), [(ia, ib), (ib, ic), (ic, ia)].into_iter().collect());

        // No base change → a no-op (0,0): the write is genuinely delta-only.
        assert_eq!(
            engine.eval_derive_materialize_incremental(src, EvalLimits::none()).unwrap(),
            (0, 0)
        );

        // Remove IMPORTS_FROM a→b → the derived DEPENDS_ON a→b is tombstoned (1 removed).
        engine.delete_edge(ia, ib, "IMPORTS_FROM");
        engine.flush().expect("flush base delete");
        assert_eq!(
            engine.eval_derive_materialize_incremental(src, EvalLimits::none()).unwrap(),
            (0, 1)
        );
        assert_eq!(
            deps(&engine),
            [(ib, ic), (ic, ia)].into_iter().collect(),
            "DEPENDS_ON a→b tombstoned; the rest intact"
        );
    }

    /// Gate D2: the maintain-based `@materialize` (`eval_derive_maintain_writeback`) produces
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
            let stats = crate::derive::builtin::Stats {
                total_nodes: all_nodes.len() as u64,
                total_edges: engine.store.edge_count_at(&snap) as u64,
                nodes_by_type: nbt,
            };
            let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
            let (eval, _specs, _node_specs) = crate::derive::evaluate_with_materialize(
                &view,
                src,
                stats,
                EvalLimits::none(),
                crate::derive::events::EventLog::discard(),
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
        let eval_at = |engine: &GraphEngineV2| -> crate::derive::exec::Evaluation {
            let snap = engine.snapshot();
            let all_nodes = engine.store.find_nodes_at(&snap, None, None);
            let mut nbt: HashMap<String, u64> = HashMap::new();
            for n in &all_nodes {
                *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
            }
            let stats = crate::derive::builtin::Stats {
                total_nodes: all_nodes.len() as u64,
                total_edges: engine.store.edge_count_at(&snap) as u64,
                nodes_by_type: nbt,
            };
            let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
            crate::derive::evaluate_with_materialize(
                &view,
                src,
                stats,
                EvalLimits::none(),
                crate::derive::events::EventLog::discard(),
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
            .eval_derive_materialize_incremental(src, EvalLimits::none())
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
                .eval_derive_maintain_writeback(src, &prev_eval, prev_snap.clone(), EvalLimits::none())
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

    /// W9: the UNCHANGED-graph short-circuit in `derive_for_materialize` — when the
    /// manifest version did not move since the cached run, the cached evaluation is
    /// returned verbatim (no diff_base scan, no maintain, no scratch), the write-back
    /// derives the exact no-op, and the result stays ≡ scratch. Call sequence: #1 miss
    /// (scratch, writes, version advances past the pinned read snapshot), #2 maintain
    /// (prev pinned BEFORE #1's commit ⇒ versions differ), #3 short-circuit (#2 wrote
    /// nothing ⇒ version unchanged).
    #[test]
    fn cached_materialize_short_circuits_on_unchanged_version() {
        use crate::datalog::EvalLimits;
        use std::sync::atomic::Ordering;
        let src = r#"@materialize(edge_type = "DEPENDS_ON")
                     dep(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;

        let mut engine = GraphEngineV2::create_ephemeral();
        let a = make_v2_node("a.js->MODULE->a", "MODULE", "a", "a.js");
        let b = make_v2_node("b.js->MODULE->b", "MODULE", "b", "b.js");
        let imp = EdgeRecordV2 {
            src: a.id,
            dst: b.id,
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(vec![a, b], vec![imp], &[], HashMap::new(), &[])
            .expect("base commit");

        // #1: miss → scratch, writes the derived edge (advances the version).
        let (a1, _) = engine
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("call 1");
        assert_eq!(a1, 1);
        assert_eq!(engine.derive_unchanged_hits.load(Ordering::Relaxed), 0);

        // #2: the cached snapshot predates #1's own commit → versions differ → maintain.
        let (a2, r2) = engine
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("call 2");
        assert_eq!((a2, r2), (0, 0));
        assert_eq!(engine.derive_maintain_hits.load(Ordering::Relaxed), 1);
        assert_eq!(engine.derive_unchanged_hits.load(Ordering::Relaxed), 0);

        // #3: nothing committed since #2 → same version → the cached evaluation is the
        // answer, with neither maintain nor scratch work.
        let (a3, r3) = engine
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("call 3");
        assert_eq!((a3, r3), (0, 0));
        assert_eq!(engine.derive_maintain_hits.load(Ordering::Relaxed), 1, "no second maintain");
        assert_eq!(
            engine.derive_unchanged_hits.load(Ordering::Relaxed),
            1,
            "short-circuit fired"
        );

        // And the materialized state is still exactly the derived edge.
        let snap = engine.snapshot();
        assert_eq!(engine.store.get_edges_by_type_at(&snap, "DEPENDS_ON").len(), 1);
    }

    /// W9 must-fix regression (delete→re-add at the SAME manifest version): a flushed
    /// delete publishes the tombstone at version V; a later `add_edges` of the same
    /// `(src, dst, type)` un-tombstones IN PLACE (`ManifestStore::remove_tombstone_edges`)
    /// — same version, the old segment record resurrected — so "same version ⇒
    /// identical committed data" is FALSE across that window (the production pattern is
    /// the compaction enricher's delete-by-source + re-emit). Every version-keyed
    /// derive mechanism must treat it as a data change:
    ///  (a) the unchanged-version short-circuit must NOT serve the stale cached
    ///      evaluation (tombstone-`Arc` `ptr_eq` guard) — the maintain path re-derives
    ///      from the resurrected base edge;
    ///  (b) the planner stats cache must miss and recount (`Arc`-keyed entry);
    ///  (c) the shared Part-A index cache must be dropped wholesale (engine-side
    ///      `invalidate_all`), so a later eval at this version cannot seed
    ///      pre-resurrection indexes.
    #[test]
    fn delete_then_readd_same_version_invalidates_derive_caches() {
        use crate::datalog::EvalLimits;
        use std::sync::atomic::Ordering;
        let src = r#"@materialize(edge_type = "DEPENDS_ON")
                     dep(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;

        let mut engine = GraphEngineV2::create_ephemeral();
        let a = make_v2_node("a.js->MODULE->a", "MODULE", "a", "a.js");
        let b = make_v2_node("b.js->MODULE->b", "MODULE", "b", "b.js");
        let (aid, bid) = (a.id, b.id);
        let imp = || EdgeRecordV2 {
            src: aid,
            dst: bid,
            edge_type: "IMPORTS_FROM".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(vec![a, b], vec![imp()], &[], HashMap::new(), &[])
            .expect("base commit");

        // Materialize (miss → scratch, writes DEPENDS_ON), then DELETE the base edge.
        engine
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("call 1");
        engine.delete_edge(aid, bid, "IMPORTS_FROM");
        engine.flush().expect("base delete flush");
        // Maintain sees the deletion and removes the derived edge.
        let (_, r2) = engine
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("call 2");
        assert_eq!(r2, 1, "derived DEPENDS_ON removed after the base delete");
        // One more call so the cached prior snapshot is pinned AT the current version
        // (call 2's own write-back advanced past its pinned read snapshot).
        engine
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("call 3");
        let unchanged_before = engine.derive_unchanged_hits.load(Ordering::Relaxed);

        // Populate the stats cache at the current version, pre-resurrection.
        let v_before = engine.snapshot().version;
        let snap_pre = engine.snapshot();
        assert_eq!(
            engine.derive_stats(&snap_pre).total_edges,
            0,
            "base edge tombstoned + derived edge removed ⇒ no visible edges"
        );

        // ── THE WINDOW: re-add the SAME (src, dst, type); NO flush. ──
        engine.add_edges(vec![edge_v2_to_v1(&imp())], true);
        let snap = engine.snapshot();
        assert_eq!(snap.version, v_before, "no flush ⇒ the version must NOT move");
        assert_eq!(
            engine.store.get_edges_by_type_at(&snap, "IMPORTS_FROM").len(),
            1,
            "the old segment record is resurrected at the SAME version"
        );

        // (b) stats: same version, fresh tombstone Arc ⇒ the cache must miss + recount.
        assert_eq!(
            engine.derive_stats(&snap).total_edges,
            1,
            "stats must see the resurrected edge at the unchanged version"
        );

        // (c) shared indexes: dropped wholesale by the un-tombstone.
        assert_eq!(
            engine.derive_shared_indexes.snapshot_counts(),
            (None, 0),
            "shared Part-A indexes must be invalidated on un-tombstone"
        );

        // (a) the short-circuit must NOT fire (same version, different tombstone Arc);
        // the maintain path re-derives from the resurrected base edge.
        let (added, removed) = engine
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("call 4 (post-resurrection)");
        assert_eq!(
            engine.derive_unchanged_hits.load(Ordering::Relaxed),
            unchanged_before,
            "the unchanged-version short-circuit must NOT serve the stale evaluation"
        );
        assert_eq!(
            (added, removed),
            (1, 0),
            "DEPENDS_ON re-derived from the resurrected base edge"
        );
        let snap_after = engine.snapshot();
        assert_eq!(engine.store.get_edges_by_type_at(&snap_after, "DEPENDS_ON").len(), 1);
        assert_eq!(engine.store.get_edges_by_type_at(&snap_after, "IMPORTS_FROM").len(), 1);
    }

    /// Node companion of the test above: `add_nodes` after a flushed node delete
    /// un-tombstones via `ManifestStore::remove_tombstone_nodes` — the same in-place
    /// same-version mutation — and must equally drop the version-keyed derive caches
    /// (stats recount + shared index invalidation).
    #[test]
    fn node_delete_then_readd_same_version_invalidates_derive_caches() {
        use crate::datalog::EvalLimits;
        let mut engine = GraphEngineV2::create_ephemeral();
        let a = make_v2_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js");
        let aid = a.id;
        engine
            .commit_batch_ext(vec![a], vec![], &[], HashMap::new(), &[])
            .expect("base commit");

        engine.delete_node(aid);
        engine.flush().expect("delete flush");
        // Stamp the shared index cache at the current version: a `@materialize` run
        // routes through `evaluate_with_materialize_shared` (the shared-cache entry;
        // plain `eval_derive` does not), and deriving nothing commits nothing,
        // so the version stays put.
        engine
            .eval_derive_materialize_cached(
                "@materialize(edge_type = \"NEVER\")\nx(A, B) :- edge(A, B, \"NO_SUCH\").",
                EvalLimits::none(),
            )
            .expect("stamp eval");
        let v_before = engine.snapshot().version;
        let snap_pre = engine.snapshot();
        assert_eq!(engine.derive_stats(&snap_pre).total_nodes, 0, "node tombstoned");
        let (stamp, _) = engine.derive_shared_indexes.snapshot_counts();
        assert_eq!(stamp, Some(v_before), "shared cache stamped at the current version");

        // Re-add the SAME node id; NO flush — un-tombstone in place.
        engine.add_nodes(vec![make_v1_node(aid, "FUNCTION", "f", "a.js")]);
        let snap = engine.snapshot();
        assert_eq!(snap.version, v_before, "no flush ⇒ the version must NOT move");
        assert_eq!(
            engine.derive_stats(&snap).total_nodes,
            1,
            "stats must see the resurrected node at the unchanged version"
        );
        assert_eq!(
            engine.derive_shared_indexes.snapshot_counts(),
            (None, 0),
            "shared Part-A indexes must be invalidated on node un-tombstone"
        );
        // And the eval at the unchanged version sees the resurrected node.
        let rows = engine
            .eval_derive("f(X) :- node(X, \"FUNCTION\").", "f", EvalLimits::none())
            .expect("eval post-resurrection");
        assert_eq!(rows.len(), 1, "resurrected node derivable at the same version");
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
            let stats = crate::derive::builtin::Stats {
                total_nodes: all_nodes.len() as u64,
                total_edges: engine.store.edge_count_at(&snap) as u64,
                nodes_by_type: nbt,
            };
            let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
            let (eval, _s, _ns) = crate::derive::evaluate_with_materialize(
                &view,
                src,
                stats,
                EvalLimits::none(),
                crate::derive::events::EventLog::discard(),
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
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("first materialize");
        assert_eq!(deps(&engine), dep_scratch(&engine), "first (miss) ≡ scratch");
        assert_eq!(engine.derive_maintain_hits.load(Ordering::Relaxed), 0, "first call is a miss");
        assert_eq!(engine.derive_materialize_cache.len(), 1, "cache populated after first call");

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
                .eval_derive_materialize_cached(src, EvalLimits::none())
                .expect("cached materialize");
            assert_eq!(
                deps(&engine),
                dep_scratch(&engine),
                "cached DEPENDS_ON ≡ scratch after edit add={add} m{s}→m{d}"
            );
            assert_eq!(
                engine.derive_maintain_hits.load(Ordering::Relaxed),
                (i as u64) + 1,
                "maintain path fired on cache hit #{}",
                i + 1
            );
        }
        assert_eq!(
            engine.derive_materialize_cache.len(),
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
        let src = crate::derive::stdlib::DEPENDS_DL;

        let depends_scratch = |engine: &GraphEngineV2| -> std::collections::HashSet<(u128, u128)> {
            let snap = engine.snapshot();
            let all_nodes = engine.store.find_nodes_at(&snap, None, None);
            let mut nbt: HashMap<String, u64> = HashMap::new();
            for n in &all_nodes {
                *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
            }
            let stats = crate::derive::builtin::Stats {
                total_nodes: all_nodes.len() as u64,
                total_edges: engine.store.edge_count_at(&snap) as u64,
                nodes_by_type: nbt,
            };
            let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(&engine.store, snap);
            let (eval, _s, _ns) = crate::derive::evaluate_with_materialize(
                &view,
                src,
                stats,
                EvalLimits::none(),
                crate::derive::events::EventLog::discard(),
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
            .eval_derive_materialize_cached(src, EvalLimits::none())
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
                .eval_derive_materialize_cached(src, EvalLimits::none())
                .expect("cached materialize");
            assert_eq!(
                deps(&engine),
                depends_scratch(&engine),
                "bundled depends.dl maintained ≡ scratch after edit add={add} m{s}→m{d}"
            );
            assert_eq!(
                engine.derive_maintain_hits.load(Ordering::Relaxed),
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
        let src = crate::derive::stdlib::DEPENDS_DL;

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
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("full materialize");
        let t_full = t0.elapsed();
        assert_eq!(engine.derive_maintain_hits.load(Ordering::Relaxed), 0, "first call is a miss");
        assert_eq!(added0, n_edges, "full run materializes one DEPENDS_ON per distinct import");

        // 1-edge reanalysis (cache hit → maintain). (0 → N-2) is not among the seeded next-three.
        engine
            .commit_batch_ext(Vec::new(), vec![imp(0, N - 2)], &[], HashMap::new(), &[])
            .expect("reanalysis edge commit");
        let t1 = Instant::now();
        let (added1, removed1) = engine
            .eval_derive_materialize_cached(src, EvalLimits::none())
            .expect("reanalysis materialize");
        let t_maintain = t1.elapsed();
        assert_eq!(engine.derive_maintain_hits.load(Ordering::Relaxed), 1, "reanalysis took the maintain path");
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

    /// The 4th q-error layer regression gate (build-once base legs over the REAL LSM read
    /// path): the bundled method-calls pack at n=20_000 over an ephemeral LSM store —
    /// the same synthetic topology as `derive::stdlib`'s scaling probe — must
    /// (a) derive EXACTLY the same fact counts as the identical topology evaluated on the
    /// in-memory `FixtureStorageView` (in-memory fast / LSM slow was the same-algorithm
    /// differential that isolated per-probe storage cost), and (b) finish far below the
    /// per-row-probe catastrophe (>900 s on the real graph): 60 s release bound, actual
    /// time printed.
    #[test]
    fn method_calls_pack_on_real_lsm_store_matches_fixture_and_runs_fast() {
        use crate::datalog::EvalLimits;
        use crate::derive::storage_glue::{EdgeRow, FixtureStorageView, NodeRow};

        fn id_of(semantic_id: &str) -> u128 {
            u128::from_le_bytes(
                blake3::hash(semantic_id.as_bytes()).as_bytes()[0..16]
                    .try_into()
                    .unwrap(),
            )
        }

        // ── The scaling-probe topology at n, built simultaneously as fixture rows and
        //    as one engine commit batch (identical ids, columns, and edges). ──
        let n = 20_000usize;
        let mut fixture = FixtureStorageView::new(1);
        let mut nodes_v2: Vec<NodeRecordV2> = Vec::new();
        let mut edges_v2: Vec<EdgeRecordV2> = Vec::new();
        {
            let mut add_node = |sid: &str, ty: &str, name: &str, file: &str| {
                let id = id_of(sid);
                fixture.put_node(NodeRow {
                    id,
                    node_type: ty.to_string(),
                    name: name.to_string(),
                    file: file.to_string(),
                });
                nodes_v2.push(NodeRecordV2 {
                    semantic_id: sid.to_string(),
                    id,
                    node_type: ty.to_string(),
                    name: name.to_string(),
                    file: file.to_string(),
                    content_hash: 0,
                    metadata: String::new(),
                });
            };
            // 1000 methods over 600 names: m{0..400} unique, m{400..600} duplicated 3x.
            let mut mi = 0;
            for name_idx in 0..600 {
                let copies = if name_idx < 400 { 1 } else { 3 };
                for c in 0..copies {
                    let sid = format!("M{mi}_{c}");
                    add_node(&sid, "METHOD", &format!("m{name_idx}"), &format!("f{name_idx}.ts"));
                    mi += 1;
                }
            }
            add_node("CLS", "CLASS", "Cls", "cls.ts");
            for i in 0..n {
                let csid = format!("C{i}");
                add_node(&csid, "CALL", &format!("recv.m{}", i % 600), &format!("app{}.ts", i % 50));
                if i % 10 == 0 {
                    add_node(&format!("PA{i}"), "PROPERTY_ACCESS", "recv", "app.ts");
                    add_node(&format!("RF{i}"), "REFERENCE", "recv", "app.ts");
                    add_node(&format!("V{i}"), "VARIABLE", "recv", "app.ts");
                }
            }
            let mut add_edge = |src: &str, dst: &str, ty: &str| {
                fixture.put_edge(EdgeRow {
                    src: id_of(src),
                    dst: id_of(dst),
                    edge_type: ty.to_string(),
                });
                edges_v2.push(EdgeRecordV2 {
                    src: id_of(src),
                    dst: id_of(dst),
                    edge_type: ty.to_string(),
                    metadata: String::new(),
                });
            };
            for name_idx in 400..600 {
                let first_copy_sid = format!("M{}_0", 400 + (name_idx - 400) * 3);
                add_edge("CLS", &first_copy_sid, "HAS_METHOD");
            }
            for i in (0..n).step_by(10) {
                let csid = format!("C{i}");
                add_edge(&csid, &format!("PA{i}"), "DERIVES_FROM");
                add_edge(&format!("PA{i}"), &format!("RF{i}"), "READS_FROM");
                add_edge(&format!("RF{i}"), &format!("V{i}"), "READS_FROM");
                add_edge(&format!("V{i}"), "CLS", "INSTANCE_OF");
            }
        }

        // ── Ground truth: the in-memory fixture evaluation. ──
        let t_fix = Instant::now();
        let fix_eval = crate::derive::evaluate(
            &fixture,
            crate::derive::stdlib::METHOD_CALLS_DL,
            crate::derive::builtin::Stats::default(),
            EvalLimits::none(),
            crate::derive::events::EventLog::discard(),
        )
        .expect("fixture eval");
        let dt_fix = t_fix.elapsed();
        let fix_unique = fix_eval.facts("resolved_unique_call").len();
        let fix_inst = fix_eval.facts("resolved_method_call").len();
        eprintln!("method_calls pack @ n={n} in-memory fixture: {dt_fix:?}");
        assert!(fix_unique > 0 && fix_inst > 0, "both strategies must fire on the fixture");

        // ── The REAL LSM read path: ephemeral engine, one batch commit + flush. ──
        let mut engine = GraphEngineV2::create_ephemeral();
        engine
            .commit_batch_ext(nodes_v2, edges_v2, &[], HashMap::new(), &[])
            .expect("commit topology");
        engine.flush().expect("flush");

        let t0 = Instant::now();
        // Mirror `eval_derive`'s stats + pinned-view construction exactly.
        let snapshot = engine.snapshot();
        let all_nodes = engine.store.find_nodes_at(&snapshot, None, None);
        let mut nodes_by_type: HashMap<String, u64> = HashMap::new();
        for nd in &all_nodes {
            *nodes_by_type.entry(nd.node_type.clone()).or_insert(0) += 1;
        }
        let stats = crate::derive::builtin::Stats {
            total_nodes: all_nodes.len() as u64,
            total_edges: engine.store.edge_count_at(&snapshot) as u64,
            nodes_by_type,
        };
        let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(&engine.store, snapshot);
        let lsm_eval = crate::derive::evaluate(
            &view,
            crate::derive::stdlib::METHOD_CALLS_DL,
            stats,
            EvalLimits::none(),
            crate::derive::events::EventLog::discard(),
        )
        .expect("LSM eval");
        let dt = t0.elapsed();
        let lsm_unique = lsm_eval.facts("resolved_unique_call").len();
        let lsm_inst = lsm_eval.facts("resolved_method_call").len();
        eprintln!(
            "method_calls pack @ n={n} REAL LSM store: {dt:?} \
             (resolved_unique={lsm_unique}, instance_of={lsm_inst}); \
             fixture ground truth: resolved_unique={fix_unique}, instance_of={fix_inst}"
        );

        // (a) Byte-identical fact counts vs the in-memory evaluation of the same topology.
        assert_eq!(lsm_unique, fix_unique, "resolved_unique_call counts diverge LSM vs fixture");
        assert_eq!(lsm_inst, fix_inst, "resolved_method_call counts diverge LSM vs fixture");

        // (b) Perf gate (release builds only — debug is uniformly ~10x slower): the
        // per-row-probe pathology was >900 s on the real graph; 60 s is a generous bound
        // for n=20k on the real LSM read path.
        if cfg!(not(debug_assertions)) {
            assert!(
                dt < std::time::Duration::from_secs(60),
                "method_calls pack on the real LSM store took {dt:?} (bound: 60 s)"
            );
        }
    }

    #[test]
    fn test_count_edges_by_type_zero_seed() {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            make_v1_node(900, "FUNCTION", "a", "src/a.js"),
            make_v1_node(901, "FUNCTION", "b", "src/a.js"),
        ]);
        engine.add_edges(
            vec![EdgeRecord {
                src: 900,
                dst: 901,
                edge_type: Some("CALLS".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            false,
        );
        // MVCC B2: buffered writes are invisible until publish — count_edges_by_type
        // reads the published snapshot (get_all_edges), so flush first.
        engine.flush().expect("flush");

        // Requesting a type that has edges — should return the count
        let result = engine.count_edges_by_type(Some(&["CALLS".to_string()]));
        assert_eq!(result.get("CALLS"), Some(&1));

        // Requesting a type with zero matching edges — must return 0, not absent
        let result = engine.count_edges_by_type(Some(&["INSTANCE_OF".to_string()]));
        assert_eq!(
            result.get("INSTANCE_OF"),
            Some(&0),
            "zero-count key must be present in result"
        );

        // Wildcard types are NOT seeded — absence is expected when no matches
        let result = engine.count_edges_by_type(Some(&["INST*".to_string()]));
        assert_eq!(result.get("INST*"), None, "wildcard key should not be seeded");

        // None filter counts all edges, no zero-seeding
        let result = engine.count_edges_by_type(None);
        assert_eq!(result.get("CALLS"), Some(&1));
    }

    // ── W8 Part 2: durable clear ─────────────────────────────────────

    /// The clear-placebo regression (gaps.md 2026-06-09): clear → drop → REOPEN the same
    /// path must see an EMPTY graph (the old behavior swapped to ephemeral and the old
    /// disk resurrected). Also pins: post-clear writes persist and reopen cleanly, and no
    /// stale pre-clear segment file survives on disk.
    #[test]
    fn w8_durable_clear_truncates_disk_and_survives_reopen() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("clear.rfdb");

        let count_segment_files = |p: &std::path::Path| -> usize {
            fn walk(p: &std::path::Path, n: &mut usize) {
                if let Ok(rd) = std::fs::read_dir(p) {
                    for e in rd.flatten() {
                        let path = e.path();
                        if path.is_dir() {
                            walk(&path, n);
                        } else {
                            *n += 1;
                        }
                    }
                }
            }
            let mut n = 0;
            walk(&p.join("segments"), &mut n);
            n
        };

        {
            let mut engine = GraphEngineV2::create(&db_path).unwrap();
            let a = make_v2_node("a.js->FUNCTION->f1", "FUNCTION", "f1", "a.js");
            let b = make_v2_node("a.js->FUNCTION->f2", "FUNCTION", "f2", "a.js");
            let (ida, idb) = (a.id, b.id);
            engine.store.add_nodes(vec![a, b]);
            engine.add_edges(
                vec![EdgeRecord {
                    src: ida,
                    dst: idb,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".to_string(),
                    metadata: None,
                    deleted: false,
                }],
                false,
            );
            engine.flush().unwrap();
            assert_eq!(engine.node_count(), 2);
            assert!(count_segment_files(&db_path) > 0, "data segments exist pre-clear");

            engine.clear_durable().unwrap();
            assert_eq!(engine.node_count(), 0, "live engine sees empty graph");
            assert_eq!(engine.edge_count(), 0);
            assert_eq!(
                count_segment_files(&db_path),
                0,
                "no pre-clear segment file survives on disk"
            );
        }

        // THE regression: reopen the same path — the old graph must NOT resurrect.
        {
            let engine = GraphEngineV2::open(&db_path).unwrap();
            assert_eq!(engine.node_count(), 0, "reopen after clear sees an EMPTY graph");
            assert_eq!(engine.edge_count(), 0);
        }

        // The cleared database is fully usable: write, flush, reopen — only new data.
        {
            let mut engine = GraphEngineV2::open(&db_path).unwrap();
            let c = make_v2_node("c.js->FUNCTION->g", "FUNCTION", "g", "c.js");
            engine.store.add_nodes(vec![c]);
            engine.flush().unwrap();
            assert_eq!(engine.node_count(), 1);
        }
        {
            let engine = GraphEngineV2::open(&db_path).unwrap();
            assert_eq!(engine.node_count(), 1, "post-clear data persists across reopen");
        }
    }

    // ── W8 Part 3: durable D2 pin (maintain cache across restart) ────

    /// Program-key derivation — must mirror `eval_derive_materialize_cached` exactly.
    /// It CALLS the production derivation rather than re-deriving it: a hand-copied
    /// mirror silently rots the moment the key gains a component (it did, when the key
    /// started carrying the rule-source bit), and the test then asserts against a
    /// sidecar filename that production never writes. These W8 databases are text-mode.
    fn w8_program_key(source: &str) -> u64 {
        GraphEngineV2::derive_program_key(source, crate::derive::RuleSource::Text)
    }

    /// materialize → (drop = server restart) → reopen → materialize again must take the
    /// rehydrated short-circuit (NO scratch eval: the test counter proves the path), and a
    /// mutation between restarts must fall back to scratch (version mismatch — no
    /// laundering).
    #[test]
    fn w8_durable_pin_rehydrates_across_restart_and_mutation_falls_back_to_scratch() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("pin.rfdb");
        // Reads CALLS, writes W8_DEP: read/write-disjoint ⇒ persistable after a
        // non-empty write-back delta.
        const SRC: &str =
            "@materialize(edge_type=\"W8_DEP\")\ndep(A, B) :- edge(A, B, \"CALLS\").";

        let mk_edge = |src: u128, dst: u128, ty: &str| EdgeRecord {
            src,
            dst,
            edge_type: Some(ty.to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        };

        let (ida, idb, idc);
        {
            let mut engine = GraphEngineV2::create(&db_path).unwrap();
            let a = make_v2_node("a.js->FUNCTION->f1", "FUNCTION", "f1", "a.js");
            let b = make_v2_node("a.js->FUNCTION->f2", "FUNCTION", "f2", "a.js");
            let c = make_v2_node("a.js->FUNCTION->f3", "FUNCTION", "f3", "a.js");
            (ida, idb, idc) = (a.id, b.id, c.id);
            engine.store.add_nodes(vec![a, b, c]);
            engine.add_edges(vec![mk_edge(ida, idb, "CALLS")], false);
            engine.flush().unwrap();

            // Run 1: cold cache, scratch + write-back (1 derived edge added).
            let counts = engine
                .eval_derive_materialize_cached(SRC, crate::datalog::EvalLimits::none())
                .unwrap();
            assert_eq!(counts, (1, 0), "first run writes the derived edge");
            assert!(
                db_path
                    .join(crate::derive::pin_sidecar::SIDECAR_DIR)
                    .join(format!("{:016x}.pin", w8_program_key(SRC)))
                    .exists(),
                "a read/write-disjoint program persists its durable pin"
            );
        } // drop = restart

        {
            let mut engine = GraphEngineV2::open(&db_path).unwrap();
            // Run 2 (cold process): the in-process cache is empty — the durable pin must
            // rehydrate and the derive must take the unchanged-graph short-circuit.
            let counts = engine
                .eval_derive_materialize_cached(SRC, crate::datalog::EvalLimits::none())
                .unwrap();
            assert_eq!(counts, (0, 0), "rehydrated run has nothing to re-write");
            assert_eq!(
                engine
                    .derive_unchanged_hits
                    .load(std::sync::atomic::Ordering::Relaxed),
                1,
                "the rehydrated pin must take the unchanged short-circuit, not scratch"
            );
            // The derived edge is still there (nothing was tombstoned).
            assert_eq!(engine.get_outgoing_edges(ida, Some(&["W8_DEP"])).len(), 1);
        } // drop = restart

        {
            // Mutation BETWEEN restarts: a new CALLS edge advances the version.
            let mut engine = GraphEngineV2::open(&db_path).unwrap();
            engine.add_edges(vec![mk_edge(idb, idc, "CALLS")], false);
            engine.flush().unwrap();

            // Run 3 (cold process, version moved): pin version mismatch ⇒ SCRATCH (no
            // laundering), and the result reflects the new base fact.
            let counts = engine
                .eval_derive_materialize_cached(SRC, crate::datalog::EvalLimits::none())
                .unwrap();
            assert_eq!(counts, (1, 0), "scratch run derives + writes the new edge");
            assert_eq!(
                engine
                    .derive_unchanged_hits
                    .load(std::sync::atomic::Ordering::Relaxed),
                0,
                "a stale pin must NOT short-circuit"
            );
            assert_eq!(
                engine
                    .derive_maintain_hits
                    .load(std::sync::atomic::Ordering::Relaxed),
                0,
                "a stale pin must NOT seed maintain either — scratch is the floor"
            );
        }
    }

    /// A program that READS an edge type it WRITES (self-feeding) must NOT persist a pin
    /// after a non-empty write-back delta — its evaluation is not provably the fixpoint
    /// of the post-commit state. (The empty-delta case is exact-state and always sound.)
    #[test]
    fn w8_durable_pin_refused_for_self_reading_program() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("selfpin.rfdb");
        // Writes CALLS (additive) while another rule READS CALLS.
        const SRC: &str = "@materialize(edge_type=\"CALLS\", mode=\"additive\")\n\
                           c(A, B) :- edge(A, B, \"W8_SRC\").\n\
                           helper(A, B) :- edge(A, B, \"CALLS\").";

        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        let a = make_v2_node("a.js->FUNCTION->f1", "FUNCTION", "f1", "a.js");
        let b = make_v2_node("a.js->FUNCTION->f2", "FUNCTION", "f2", "a.js");
        let (ida, idb) = (a.id, b.id);
        engine.store.add_nodes(vec![a, b]);
        engine.add_edges(
            vec![EdgeRecord {
                src: ida,
                dst: idb,
                edge_type: Some("W8_SRC".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            false,
        );
        engine.flush().unwrap();

        let counts = engine
            .eval_derive_materialize_cached(SRC, crate::datalog::EvalLimits::none())
            .unwrap();
        assert_eq!(counts.0, 1, "the additive CALLS edge is written");
        assert!(
            crate::derive::pin_sidecar::load(&db_path, w8_program_key(SRC)).is_none(),
            "self-reading program must not persist a durable pin after a non-empty delta"
        );
    }

    /// W8 Part 3 rider gate: buffered writes pending at write-back entry RIDE the
    /// write-back commit (the engine flush publishes ALL pending state, MVCC B2
    /// visibility=publish). A non-empty-delta pin keyed to the post-commit snapshot
    /// would then claim an evaluation that never saw the riders — even for a
    /// read/write-disjoint program, because riders can be of types the program READS.
    /// Such a run must persist NO pin (and drop a stale one); the restart pays scratch
    /// and sees the riders.
    #[test]
    fn w8_durable_pin_refused_when_pending_writes_ride_the_writeback() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("riderpin.rfdb");
        // Reads CALLS, writes W8_DEP — read/write-disjoint, so WITHOUT riders the
        // non-empty-delta persist is allowed (proven by the rehydrate test above).
        const SRC: &str =
            "@materialize(edge_type=\"W8_DEP\")\ndep(A, B) :- edge(A, B, \"CALLS\").";

        let mk_edge = |src: u128, dst: u128, ty: &str| EdgeRecord {
            src,
            dst,
            edge_type: Some(ty.to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        };

        let (ida, idb, idc, idd);
        {
            let mut engine = GraphEngineV2::create(&db_path).unwrap();
            let a = make_v2_node("a.js->FUNCTION->f1", "FUNCTION", "f1", "a.js");
            let b = make_v2_node("a.js->FUNCTION->f2", "FUNCTION", "f2", "a.js");
            let c = make_v2_node("a.js->FUNCTION->f3", "FUNCTION", "f3", "a.js");
            let d = make_v2_node("a.js->FUNCTION->f4", "FUNCTION", "f4", "a.js");
            (ida, idb, idc, idd) = (a.id, b.id, c.id, d.id);
            engine.store.add_nodes(vec![a, b, c, d]);
            engine.add_edges(vec![mk_edge(ida, idb, "CALLS")], false);
            engine.flush().unwrap();

            // Run 1: clean (no riders) — the disjoint program persists its pin.
            let counts = engine
                .eval_derive_materialize_cached(SRC, crate::datalog::EvalLimits::none())
                .unwrap();
            assert_eq!(counts, (1, 0));
            assert!(
                crate::derive::pin_sidecar::load(&db_path, w8_program_key(SRC)).is_some(),
                "rider-free run persists the pin (baseline)"
            );

            // A COMMITTED base change (so run 2 has a non-empty write-back delta)…
            engine.add_edges(vec![mk_edge(idb, idc, "CALLS")], false);
            engine.flush().unwrap();
            // …plus an UNFLUSHED rider of a type the program READS. It will ride
            // run 2's write-back flush into the post-commit snapshot, which the
            // evaluation (computed at the pre-commit snapshot) never saw.
            engine.add_edges(vec![mk_edge(idc, idd, "CALLS")], false);
            assert!(engine.store.has_buffered_writes(), "rider really is pending");

            // Run 2: non-empty delta (dep(b,c) is new) + riders pending ⇒ the pin
            // must be REFUSED and the stale run-1 sidecar dropped.
            let counts = engine
                .eval_derive_materialize_cached(SRC, crate::datalog::EvalLimits::none())
                .unwrap();
            assert_eq!(counts, (1, 0), "run 2 writes the dep(b,c) delta");
            assert!(
                crate::derive::pin_sidecar::load(&db_path, w8_program_key(SRC)).is_none(),
                "a write-back that publishes riders must not persist a durable pin"
            );
        } // drop = restart

        {
            // Restart: no pin ⇒ scratch (no laundering), and the scratch run SEES the
            // rider — dep(c,d) is derived and written. A wrongly-persisted pin would
            // have rehydrated here and silently never derived it.
            let mut engine = GraphEngineV2::open(&db_path).unwrap();
            let counts = engine
                .eval_derive_materialize_cached(SRC, crate::datalog::EvalLimits::none())
                .unwrap();
            assert_eq!(
                engine
                    .derive_unchanged_hits
                    .load(std::sync::atomic::Ordering::Relaxed),
                0,
                "no pin may rehydrate after a rider-contaminated write-back"
            );
            assert_eq!(counts, (1, 0), "scratch derives the rider's consequence dep(c,d)");
            assert_eq!(engine.get_outgoing_edges(idc, Some(&["W8_DEP"])).len(), 1);
        }
    }

    /// Durable clear removes the pin sidecar directory: a post-clear restart must not
    /// rehydrate pre-clear evaluations (the version counter resets — a stale pin keyed
    /// to an old version 2 could collide with a fresh version 2 after clear).
    #[test]
    fn w8_durable_clear_drops_pin_sidecars() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("clearpin.rfdb");
        const SRC: &str =
            "@materialize(edge_type=\"W8_DEP\")\ndep(A, B) :- edge(A, B, \"CALLS\").";

        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        let a = make_v2_node("a.js->FUNCTION->f1", "FUNCTION", "f1", "a.js");
        let b = make_v2_node("a.js->FUNCTION->f2", "FUNCTION", "f2", "a.js");
        let (ida, idb) = (a.id, b.id);
        engine.store.add_nodes(vec![a, b]);
        engine.add_edges(
            vec![EdgeRecord {
                src: ida,
                dst: idb,
                edge_type: Some("CALLS".to_string()),
                version: "main".to_string(),
                metadata: None,
                deleted: false,
            }],
            false,
        );
        engine.flush().unwrap();
        engine
            .eval_derive_materialize_cached(SRC, crate::datalog::EvalLimits::none())
            .unwrap();
        let sidecar_dir = db_path.join(crate::derive::pin_sidecar::SIDECAR_DIR);
        assert!(sidecar_dir.exists(), "pin persisted pre-clear");

        engine.clear_durable().unwrap();
        assert!(!sidecar_dir.exists(), "durable clear removes the pin sidecar dir");
    }

    // ── Rules as data: the execution seam (Projection T) ──────────────

    /// A small real graph both modes are asked about. Two FUNCTIONs, one CLASS, and a
    /// CALLS edge, so a query has something to return and a negative control has
    /// something to differ about.
    fn reflexive_fixture(dir: &std::path::Path) -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create(dir).expect("create");
        let f = make_v2_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js");
        let g = make_v2_node("a.js->FUNCTION->g", "FUNCTION", "g", "a.js");
        let c = make_v2_node("b.js->CLASS->C", "CLASS", "C", "b.js");
        let edge = EdgeRecordV2 {
            src: f.id,
            dst: g.id,
            edge_type: "CALLS".to_string(),
            metadata: String::new(),
        };
        engine
            .commit_batch_ext(
                vec![f, g, c],
                vec![edge],
                &[],
                std::collections::HashMap::new(),
                &[],
            )
            .expect("commit");
        engine.flush().expect("flush");
        engine
    }

    /// The rule source is a DURABLE property of the database: it survives a reopen, a
    /// COMPACTION, and `clear_durable` — the last of which recreates `db_config.json`
    /// through `MultiShardStore::create` and would otherwise silently demote a reflexive
    /// database to text mode (clearing the DATA must not change the PROGRAM).
    ///
    /// Compaction is in here because the design's exit condition for this stage names it
    /// beside restart and clear (`_ai/research/rofl-rules-as-data-design.md` ⟦перезапуск,
    /// сброс, уплотнение и `clear`⟧), and it is the one of the four that rewrites segment
    /// files and the manifest — the neighbourhood `db_config.json` lives in.
    #[test]
    fn the_rule_source_is_a_durable_database_property() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut engine = reflexive_fixture(dir.path());
            assert_eq!(
                engine.rule_source(),
                crate::derive::RuleSource::Text,
                "a fresh database defaults to text mode"
            );
            engine
                .set_rule_source(crate::derive::RuleSource::Store)
                .expect("set");
        }
        {
            let mut engine = GraphEngineV2::open(dir.path()).expect("reopen");
            assert_eq!(
                engine.rule_source(),
                crate::derive::RuleSource::Store,
                "the flag must survive a reopen"
            );

            // Compaction: rewrites the segments and the manifest under the very same
            // directory, in memory AND on disk.
            engine.compact_with_stats().expect("compact");
            assert_eq!(
                engine.rule_source(),
                crate::derive::RuleSource::Store,
                "compaction must not change the program"
            );
            let after_compact =
                crate::storage_v2::multi_shard::DatabaseConfig::read_from(dir.path())
                    .expect("read config")
                    .expect("config present");
            assert_eq!(
                after_compact.rule_source,
                crate::derive::RuleSource::Store,
                "db_config.json lost the rule source during compaction"
            );

            engine.clear_durable().expect("clear");
            assert_eq!(
                engine.rule_source(),
                crate::derive::RuleSource::Store,
                "clearing the data must not change the program"
            );
        }
        let engine = GraphEngineV2::open(dir.path()).expect("reopen after clear");
        assert_eq!(
            engine.rule_source(),
            crate::derive::RuleSource::Store,
            "…and the cleared database must still reopen reflexive"
        );
    }

    /// The ROFL marker is a DURABLE property of the database: it survives a reopen, and it
    /// survives `clear_durable`.
    ///
    /// The clear is the trap this test exists for. `clear_durable` rebuilds the shard
    /// skeleton, and that rewrites `db_config.json` — so unless the durable flags go into
    /// that write (`MultiShardStore::create_with_flags`), wiping the DATA silently demotes
    /// a ROFL database to an ordinary one. Verified to fail before the fix: with the clear
    /// restoring only the rule source, this test panics with `db_config.json lost the
    /// marker during clear_durable`. That the flags reach disk with no window in between
    /// is a separate property, held by
    /// `no_instant_of_clear_leaves_a_demoted_database_on_disk`.
    ///
    /// Note which assertion catches it. The IN-MEMORY `rofl_mode()` still reads `true`
    /// right after the clear even when the bug is present — the engine field was never
    /// touched. Only the on-disk check sees the loss, and only the next process to open the
    /// database would have suffered it. A test that asserted on the getter alone would pass
    /// against the broken code.
    #[test]
    fn the_rofl_marker_is_a_durable_database_property() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut engine = GraphEngineV2::create(dir.path()).expect("create");
            assert!(
                !engine.rofl_mode(),
                "a fresh database is not a ROFL database"
            );
            engine.enable_rofl_mode().expect("enable");
            assert!(engine.rofl_mode());
        }
        {
            let mut engine = GraphEngineV2::open(dir.path()).expect("reopen");
            assert!(engine.rofl_mode(), "the marker must survive a reopen");

            engine.clear_durable().expect("clear");
            assert!(
                engine.rofl_mode(),
                "the marker must survive clearing the data"
            );

            // …and not just in memory: the file on disk must carry it too, or the next
            // process to open this database would see an ordinary database.
            let on_disk = crate::storage_v2::multi_shard::DatabaseConfig::read_from(dir.path())
                .expect("read config")
                .expect("config present");
            assert!(
                on_disk.rofl_mode,
                "db_config.json lost the marker during clear_durable"
            );
        }
        let engine = GraphEngineV2::open(dir.path()).expect("reopen after clear");
        assert!(
            engine.rofl_mode(),
            "…and the cleared database must still reopen as a ROFL database"
        );
    }

    /// A durable flag whose write FAILED must not be live in memory.
    ///
    /// The failure this pins is the one the whole rules-as-data door is built against: a
    /// silence. With the mode set in memory and the file left behind, the database answers
    /// store-mode queries for the rest of the process and reverts on the next open — no
    /// error anywhere, two different answers from one database. The caller does get an
    /// `Err`, but an `Err` says "it did not happen", so it MUST not have happened.
    ///
    /// The two flags are pinned together on purpose: they share
    /// [`GraphEngineV2::persist_durable_flags`], which writes every cached flag at once, so
    /// an in-memory-only value of either one is committed by the next successful write of
    /// the other — the third assertion below.
    ///
    /// Verified to fail before the fix: with `self.rule_source = mode;` left in front of the
    /// persist, this test panics at
    /// `a failed durable write must leave the rule source alone, got Store`.
    #[test]
    fn a_failed_durable_write_leaves_the_rule_source_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = GraphEngineV2::create(dir.path()).expect("create");

        // Remove the file the flags are persisted into — `persist_durable_flags` reads it
        // before writing, so this is a write that cannot succeed.
        let config_path = dir.path().join("db_config.json");
        assert!(config_path.exists(), "the fixture must start with a config file");
        std::fs::remove_file(&config_path).expect("remove config");

        let err = engine
            .set_rule_source(crate::derive::RuleSource::Store)
            .expect_err("a durable write that cannot happen must be reported");
        assert!(
            format!("{err}").contains("db_config.json"),
            "the error must name what could not be written: {err}"
        );
        assert_eq!(
            engine.rule_source(),
            crate::derive::RuleSource::Text,
            "a failed durable write must leave the rule source alone, got {:?}",
            engine.rule_source()
        );

        let err = engine
            .enable_rofl_mode()
            .expect_err("the ROFL marker is durable on the same terms");
        assert!(
            !engine.rofl_mode(),
            "a failed durable write must leave the ROFL marker alone: {err}"
        );

        // And nothing was left behind to be laundered later: restore the file, make ONE
        // successful write, and the flag that failed must still be off on disk.
        crate::storage_v2::multi_shard::DatabaseConfig {
            shard_count: 4,
            rule_source: crate::derive::RuleSource::Text,
            rofl_mode: false,
        }
        .write_to(dir.path())
        .expect("restore config");
        engine
            .set_rule_source(crate::derive::RuleSource::Store)
            .expect("the write succeeds once the file is back");
        let on_disk = crate::storage_v2::multi_shard::DatabaseConfig::read_from(dir.path())
            .expect("read config")
            .expect("config present");
        assert_eq!(on_disk.rule_source, crate::derive::RuleSource::Store);
        assert!(
            !on_disk.rofl_mode,
            "the ROFL marker never persisted, so a later write of another flag must not \
             commit it"
        );
    }

    /// Clearing must not trade one flag for the other: a database that is BOTH reflexive
    /// and ROFL keeps both.
    #[test]
    fn clear_durable_keeps_every_durable_flag_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = GraphEngineV2::create(dir.path()).expect("create");
        engine
            .set_rule_source(crate::derive::RuleSource::Store)
            .expect("set rule source");
        engine.enable_rofl_mode().expect("enable rofl");

        engine.clear_durable().expect("clear");

        assert_eq!(engine.rule_source(), crate::derive::RuleSource::Store);
        assert!(engine.rofl_mode());
        let on_disk = crate::storage_v2::multi_shard::DatabaseConfig::read_from(dir.path())
            .expect("read config")
            .expect("config present");
        assert_eq!(on_disk.rule_source, crate::derive::RuleSource::Store);
        assert!(on_disk.rofl_mode);
    }

    /// A REFUSED create must not have written anything.
    ///
    /// `create` over an existing database used to write first and refuse second:
    /// `MultiShardStore::create` overwrote `db_config.json` with a fresh default, and only
    /// then did `ManifestStore::create` report "Database already exists at path". The
    /// caller saw an error — and the database it did not create had just lost its rule
    /// source, its ROFL marker AND its shard count (replaced by this machine's auto-tuned
    /// number, over data laid out for the old one). The next process to open it got an
    /// ordinary text-mode database.
    ///
    /// The assertion is on the FILE BYTES, not on the flags: "nothing was written" is the
    /// property, and any future field gets it for free.
    #[test]
    fn a_refused_create_over_an_existing_database_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut engine = GraphEngineV2::create(dir.path()).expect("create");
            engine
                .set_rule_source(crate::derive::RuleSource::Store)
                .expect("set rule source");
            engine.enable_rofl_mode().expect("enable rofl");
        }
        let config_path = dir.path().join("db_config.json");
        let before = std::fs::read(&config_path).expect("config before");

        let err = match GraphEngineV2::create(dir.path()) {
            Ok(_) => panic!("create over an existing database must fail"),
            Err(e) => e,
        };
        assert!(
            format!("{err}").contains("already exists"),
            "expected an already-exists refusal, got: {err}"
        );

        let after = std::fs::read(&config_path).expect("config after");
        assert_eq!(
            before, after,
            "the refused create rewrote db_config.json — the database it refused to create \
             just lost its durable flags"
        );

        // And the database still IS what it was, to the next process that opens it.
        let engine = GraphEngineV2::open(dir.path()).expect("reopen after the refused create");
        assert_eq!(engine.rule_source(), crate::derive::RuleSource::Store);
        assert!(engine.rofl_mode());
    }

    /// There is no INSTANT during `clear_durable` at which the database on disk is a
    /// demoted one.
    ///
    /// A reader thread polling `db_config.json` for the whole clear stands in for a crash:
    /// whatever it can observe on disk at some instant is exactly what a power cut at that
    /// instant would have left behind. The clear used to recreate the shard skeleton with a
    /// DEFAULT config and correct it with a second write afterwards — a window (16 shard
    /// directories wide) in which the persisted database was text-mode and non-ROFL. The
    /// end state was right, so an end-state assertion could not see it.
    #[test]
    fn no_instant_of_clear_leaves_a_demoted_database_on_disk() {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().to_path_buf();
        let mut engine = GraphEngineV2::create(&db_path).expect("create");
        engine
            .set_rule_source(crate::derive::RuleSource::Store)
            .expect("set rule source");
        engine.enable_rofl_mode().expect("enable rofl");

        let stop = Arc::new(AtomicBool::new(false));
        let demoted = Arc::new(AtomicU64::new(0));
        let observations = Arc::new(AtomicU64::new(0));
        let reader = {
            let db_path = db_path.clone();
            let stop = stop.clone();
            let demoted = demoted.clone();
            let observations = observations.clone();
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    if let Ok(Some(c)) =
                        crate::storage_v2::multi_shard::DatabaseConfig::read_from(&db_path)
                    {
                        observations.fetch_add(1, Ordering::Relaxed);
                        if !c.rofl_mode || c.rule_source != crate::derive::RuleSource::Store {
                            demoted.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            })
        };

        engine.clear_durable().expect("clear");
        stop.store(true, Ordering::Relaxed);
        reader.join().unwrap();

        let observed = observations.load(Ordering::Relaxed);
        assert!(observed > 0, "the reader never ran — the test proves nothing");
        assert_eq!(
            demoted.load(Ordering::Relaxed),
            0,
            "the persisted config was a demoted database at some instant during clear \
             ({observed} observations) — a crash there is permanent"
        );
    }

    /// The shard count survives a clear, and it survives it as a property of the DATA, not
    /// of the machine running the clear.
    ///
    /// `clear_durable` took the count from the runtime tuning profile, which is derived
    /// from this host's RAM and cores. On a different machine — or after a resource
    /// re-check — clearing a 16-shard database would silently rebuild it with a different
    /// shard count, i.e. reshard it. The file it was created with is the authority.
    #[test]
    fn clear_durable_keeps_the_shard_count_of_the_database_not_of_the_machine() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = GraphEngineV2::create(dir.path()).expect("create");
        let created_with = crate::storage_v2::multi_shard::DatabaseConfig::read_from(dir.path())
            .expect("read config")
            .expect("config present")
            .shard_count;

        // Stand in for "the clear runs on a machine that tunes differently".
        engine.cached_profile.shard_count = created_with + 1;
        engine.clear_durable().expect("clear");

        let after = crate::storage_v2::multi_shard::DatabaseConfig::read_from(dir.path())
            .expect("read config")
            .expect("config present")
            .shard_count;
        assert_eq!(
            after, created_with,
            "clear resharded the database from the runtime profile ({} -> {})",
            created_with,
            engine.cached_profile.shard_count
        );
        // …and the reopened database agrees with the file.
        drop(engine);
        let reopened = GraphEngineV2::open(dir.path()).expect("reopen after clear");
        assert_eq!(reopened.store.shard_count(), created_with);
    }

    /// A REAL old config file — the exact JSON the previous build wrote, with no ROFL
    /// field — must open exactly as before: an ordinary, non-ROFL database.
    #[test]
    fn a_db_config_written_before_the_rofl_marker_opens_as_an_ordinary_database() {
        let dir = tempfile::tempdir().unwrap();
        let shard_count = {
            let _ = GraphEngineV2::create(dir.path()).expect("create");
            crate::storage_v2::multi_shard::DatabaseConfig::read_from(dir.path())
                .expect("read config")
                .expect("config present")
                .shard_count
        };

        // Byte-for-byte the two-field file the previous build produced: no `rofl_mode` key.
        std::fs::write(
            dir.path().join("db_config.json"),
            format!("{{\n  \"shard_count\": {shard_count},\n  \"rule_source\": \"text\"\n}}"),
        )
        .expect("write legacy config");

        let engine = GraphEngineV2::open(dir.path()).expect("open legacy database");
        assert!(
            !engine.rofl_mode(),
            "an absent field must mean the historical behavior, not a ROFL database"
        );
        assert_eq!(engine.rule_source(), crate::derive::RuleSource::Text);
    }

    /// A `db_config.json` written before the flag existed must still open, as text mode.
    #[test]
    fn a_pre_flag_db_config_opens_in_text_mode() {
        let dir = tempfile::tempdir().unwrap();
        {
            let _ = GraphEngineV2::create(dir.path()).expect("create");
        }
        std::fs::write(dir.path().join("db_config.json"), r#"{"shard_count": 4}"#)
            .expect("write legacy config");
        let engine = GraphEngineV2::open(dir.path()).expect("open legacy");
        assert_eq!(engine.rule_source(), crate::derive::RuleSource::Text);
    }

    /// Criterion B (positive control): the same query answered from TEXT and from the
    /// STORE must be bit-identical — and NON-EMPTY, so the agreement measures agreement
    /// and not two empty answers.
    #[test]
    fn text_mode_and_store_mode_agree_on_a_non_empty_answer() {
        const PROGRAMS: &[&str] = &[
            r#"p(X, N) :- edge(X, Y, "CALLS"), node(Y, "FUNCTION"), attr(Y, "name", N)."#,
            r#"p(X) :- node(X, "FUNCTION")."#,
            r#"p(X, Y) :- edge(X, Y, "CALLS")."#,
            r#"p(Y, X) :- node(Y, "FUNCTION"), incoming(Y, X, "CALLS")."#,
            r#"p(X) :- node(X, "FUNCTION"), \+ node(X, "CLASS")."#,
            r#"p(X, F) :- node(X, "FUNCTION"), attr(X, "file", F)."#,
            r#"q(X) :- node(X, "FUNCTION").
p(X) :- q(X)."#,
            r#"q(X, Y) :- edge(X, Y, "CALLS").
p(X, Y) :- q(X, Y).
p(X, Z) :- p(X, Y), q(Y, Z)."#,
            r#"p(X, Y) :- edge(X, Y, "CALLS"), node(Y, "FUNCTION")."#,
            r#"p(N) :- node(X, "FUNCTION"), attr(X, "name", N)."#,
            r#"q(X) :- node(X, "CLASS").
p(X) :- node(X, "FUNCTION"), \+ q(X)."#,
            r#"p(X, Y) :- edge(X, Y, "CALLS"), \+ node(X, "CLASS")."#,
        ];

        let mut non_empty = 0usize;
        for (i, src) in PROGRAMS.iter().enumerate() {
            let text_dir = tempfile::tempdir().unwrap();
            let text_engine = reflexive_fixture(text_dir.path());
            let from_text = text_engine
                .eval_derive(src, "p", crate::datalog::EvalLimits::none())
                .unwrap_or_else(|e| panic!("program {i} text mode: {e}"));

            let store_dir = tempfile::tempdir().unwrap();
            let mut store_engine = reflexive_fixture(store_dir.path());
            let written = store_engine
                .reflect_program(src)
                .unwrap_or_else(|e| panic!("program {i} reflect: {e}"));
            assert!(written > 0, "program {i} reflected no fact at all");
            store_engine
                .set_rule_source(crate::derive::RuleSource::Store)
                .expect("set");
            store_engine.flush().expect("flush");
            // The text argument is NOT the program in store mode. Hand it something that
            // could not possibly parse into these rules, so a silent fallback to text
            // would be caught rather than masked.
            let from_store = store_engine
                .eval_derive("", "p", crate::datalog::EvalLimits::none())
                .unwrap_or_else(|e| panic!("program {i} store mode: {e}"));

            let mut a = from_text.clone();
            let mut b = from_store.clone();
            a.sort();
            b.sort();
            assert_eq!(a, b, "program {i} disagreed between text and store mode");
            if !a.is_empty() {
                non_empty += 1;
            }
        }
        assert_eq!(
            non_empty,
            PROGRAMS.len(),
            "every program must return rows — an all-empty agreement proves nothing"
        );
    }

    /// Criterion C (negative control): when the text and the store DISAGREE, the answer
    /// must follow the STORE. Without this the positive control above would also pass if
    /// store mode quietly kept parsing the text.
    #[test]
    fn when_text_and_store_disagree_the_answer_follows_the_store() {
        const IN_STORE: &str = r#"p(X) :- node(X, "FUNCTION")."#;
        const IN_TEXT: &str = r#"p(X) :- node(X, "FUNCTION").
p(X) :- node(X, "CLASS")."#;

        let dir = tempfile::tempdir().unwrap();
        let mut engine = reflexive_fixture(dir.path());
        engine.reflect_program(IN_STORE).expect("reflect");
        engine
            .set_rule_source(crate::derive::RuleSource::Store)
            .expect("set");
        engine.flush().expect("flush");

        let from_store = engine
            .eval_derive(IN_TEXT, "p", crate::datalog::EvalLimits::none())
            .expect("store mode eval");
        assert_eq!(
            from_store.len(),
            2,
            "the store has ONE rule (two FUNCTIONs); the text's second rule must not fire"
        );

        // Positive control on the same graph: in text mode the very same text DOES add the
        // CLASS, so the 2 above is the store winning and not an empty/broken read.
        let text_dir = tempfile::tempdir().unwrap();
        let text_engine = reflexive_fixture(text_dir.path());
        let from_text = text_engine
            .eval_derive(IN_TEXT, "p", crate::datalog::EvalLimits::none())
            .expect("text mode eval");
        assert_eq!(from_text.len(), 3, "text mode must see all three nodes");
    }

    /// `@materialize` is refused on BOTH doors with a typed `E-REFLECT-003`.
    ///
    /// Projection T carries no annotations, so a write-back run from the store would find
    /// zero directives and commit nothing while reporting success — silent data loss.
    /// There are two ways to arrive there and both are closed:
    ///
    /// * the WRITE door — an annotated program is refused at reflection time, so the
    ///   annotation never becomes a half-program in the store;
    /// * the READ door — a database in store mode refuses a write-back request outright,
    ///   whatever text it is handed, so a store built by some other route cannot reach it
    ///   either.
    #[test]
    fn materialize_write_back_is_refused_in_store_mode() {
        const ANNOTATED: &str = r#"@materialize(edge_type="REACHES")
p(X, Y) :- edge(X, Y, "CALLS")."#;
        const PLAIN: &str = r#"p(X, Y) :- edge(X, Y, "CALLS")."#;

        let dir = tempfile::tempdir().unwrap();
        let mut engine = reflexive_fixture(dir.path());

        // The WRITE door.
        let err = engine
            .reflect_program(ANNOTATED)
            .expect_err("an annotated program must not be reflectable");
        assert_eq!(err.code(), crate::derive::reflect::E_REFLECT_MODE, "{err}");
        // Positive control: the same clause WITHOUT the annotation reflects fine, so the
        // refusal above is about the annotation and not about the rule.
        assert!(engine.reflect_program(PLAIN).expect("reflect plain") > 0);

        // The READ door.
        engine
            .set_rule_source(crate::derive::RuleSource::Store)
            .expect("set");
        engine.flush().expect("flush");

        let err = engine
            .eval_derive_materialize(ANNOTATED, crate::datalog::EvalLimits::none())
            .expect_err("materialize must refuse in store mode");
        assert_eq!(err.code(), crate::derive::reflect::E_REFLECT_MODE, "{err}");

        let err = engine
            .eval_derive_materialize_cached(ANNOTATED, crate::datalog::EvalLimits::none())
            .expect_err("the cached materialize path must refuse too");
        assert_eq!(err.code(), crate::derive::reflect::E_REFLECT_MODE, "{err}");

        // …and a plain query still works in the same database, so store mode is refusing
        // the WRITE-BACK and not simply broken.
        let rows = engine
            .eval_derive("", "p", crate::datalog::EvalLimits::none())
            .expect("plain query from the store");
        assert_eq!(rows.len(), 1, "one CALLS edge in the fixture");
    }

    /// The materialize cache/pin key must carry the mode bit. Two modes hashing to one key
    /// would let a text-mode result be served to a store-mode request — the program text
    /// degenerates in store mode, so the text hash alone collides across every program.
    #[test]
    fn the_materialize_cache_key_carries_the_mode_bit() {
        assert_ne!(
            crate::derive::RuleSource::Text.key_bit(),
            crate::derive::RuleSource::Store.key_bit(),
            "the two modes must not share a key bit"
        );
        let text_key = GraphEngineV2::derive_program_key("p(X) :- node(X, \"FUNCTION\").", crate::derive::RuleSource::Text);
        let store_key = GraphEngineV2::derive_program_key("p(X) :- node(X, \"FUNCTION\").", crate::derive::RuleSource::Store);
        assert_ne!(text_key, store_key, "one program text, two modes, two keys");
    }

    /// A rule store with a BROKEN reflection beside a healthy one still answers from the
    /// healthy rule: the decoder drops the unusable one and keeps its neighbour.
    ///
    /// The name says only what this level can measure. That the skip is also REPORTED
    /// cannot be checked here — this entry installs
    /// [`crate::derive::events::EventLog::discard`], so there is no trace to read; the
    /// assertion for that lives one level down, where a sink can be installed
    /// (`derive::reflect::tests::a_skipped_reflection_is_emitted_on_the_event_trace`).
    /// In production the same diagnostic also goes to `tracing::warn!` in
    /// [`crate::derive::program_for`], which is what makes it observable without a sink.
    #[test]
    fn a_broken_reflection_does_not_take_down_its_healthy_sibling() {
        use crate::derive::reflect::{ReflectedFact, REL_CONCLUSION_LIT, REL_RULE, rofl_atom};

        let dir = tempfile::tempdir().unwrap();
        let mut engine = reflexive_fixture(dir.path());
        engine
            .reflect_program(r#"p(X) :- node(X, "FUNCTION")."#)
            .expect("reflect");

        // A rule whose head reflection is not a literal at all.
        let bad = "rdeadbeef";
        let broken = vec![
            ReflectedFact::new(REL_RULE, vec![rofl_atom(bad)]),
            ReflectedFact::new(
                REL_CONCLUSION_LIT,
                vec![
                    rofl_atom(bad),
                    crate::datalog::Value::Int(1),
                    crate::datalog::Value::Str("not a literal".into()),
                ],
            ),
        ];
        let records: Vec<NodeRecordV2> = broken
            .iter()
            .map(|f| f.to_node_record().expect("record"))
            .collect();
        engine
            .commit_batch_ext(records, vec![], &[], std::collections::HashMap::new(), &[])
            .expect("commit");
        engine
            .set_rule_source(crate::derive::RuleSource::Store)
            .expect("set");
        engine.flush().expect("flush");

        let rows = engine
            .eval_derive("", "p", crate::datalog::EvalLimits::none())
            .expect("the healthy rule must still answer");
        assert_eq!(rows.len(), 2, "two FUNCTIONs from the surviving rule");
    }

    /// The PLANNER's view of the graph must not notice that rules moved into the store.
    ///
    /// `derive_stats` counts the store directly, not through the isolating
    /// [`crate::derive::storage_glue::StorageView`], so it is the one read point the
    /// view's filter cannot reach. These numbers feed the cost model and the
    /// cartesian-product gate (`E-PLAN-003`): if reflected nodes were counted, the same
    /// program would plan against different magnitudes in text mode and in store mode,
    /// which is precisely the difference a text-vs-store differential exists to exclude.
    #[test]
    fn reflected_rules_do_not_enter_the_planner_statistics() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = reflexive_fixture(dir.path());

        let before = engine.derive_stats(&engine.snapshot());
        assert!(
            before.total_nodes > 0,
            "positive control: the fixture has nodes to count"
        );

        // Reflect a program big enough that leaking it would be unmistakable.
        let written = engine
            .reflect_program(
                r#"p(X, N) :- edge(X, Y, "CALLS"), node(Y, "FUNCTION"), attr(Y, "name", N).
q(X) :- node(X, "FUNCTION").
r(X, Y) :- edge(X, Y, "CALLS"), \+ node(X, "CLASS")."#,
            )
            .expect("reflect");
        assert!(written >= 8, "the probe must be sizeable, wrote {written}");
        engine.flush().expect("flush");

        // Positive control on the SAME snapshot: the reserved nodes really are in the
        // store — so a clean `nodes_by_type` below is a filter, not an empty database.
        let snapshot = engine.snapshot();
        let raw = engine.store.count_nodes_by_type_at(&snapshot);
        assert_eq!(
            raw.get(crate::derive::reflect::REFLECT_NODE_TYPE).copied(),
            Some(written as u64),
            "the raw store counter must see every reflected node"
        );

        let after = engine.derive_stats(&snapshot);
        assert!(
            !after
                .nodes_by_type
                .contains_key(crate::derive::reflect::REFLECT_NODE_TYPE),
            "the reserved type must not appear in the planner's per-type map: {:?}",
            after.nodes_by_type
        );
        assert_eq!(
            after.total_nodes, before.total_nodes,
            "reflecting a program must not change the node magnitude the planner sees"
        );
        assert_eq!(
            after.nodes_by_type, before.nodes_by_type,
            "…nor any per-type magnitude"
        );
    }

    /// Clearing the DATA must not clear the PROGRAM.
    ///
    /// `clear_durable` keeps the reflexive flag (checked above), and the flag without the
    /// rules is the worst of both: the database still answers from the store, the store is
    /// empty, and every query returns nothing — a silent, total wrong answer rather than an
    /// error. So the reflected records are lifted out before the wipe and put back after.
    #[test]
    fn clear_durable_keeps_the_reflected_program() {
        const SRC: &str = r#"p(X) :- node(X, "FUNCTION")."#;
        let dir = tempfile::tempdir().unwrap();
        let mut engine = reflexive_fixture(dir.path());
        let written = engine.reflect_program(SRC).expect("reflect");
        assert!(written > 0);
        engine
            .set_rule_source(crate::derive::RuleSource::Store)
            .expect("set");
        engine.flush().expect("flush");

        // Positive control before the clear: the store answers, non-empty.
        let before = engine
            .eval_derive("", "p", crate::datalog::EvalLimits::none())
            .expect("store mode eval");
        assert_eq!(before.len(), 2, "two FUNCTIONs in the fixture");

        engine.clear_durable().expect("clear");

        // The rules survived the wipe, byte for byte: same count, same decoded clause.
        let snapshot = engine.snapshot();
        let kept = engine.store.count_nodes_by_type_at(&snapshot);
        assert_eq!(
            kept.get(crate::derive::reflect::REFLECT_NODE_TYPE).copied(),
            Some(written as u64),
            "clearing the data must not take the program with it"
        );
        let view = crate::derive::storage_glue::BorrowedLsmStorageView::new(&engine.store, snapshot);
        let index = crate::derive::reflect::rule_index(&view);
        assert_eq!(
            index.values().cloned().collect::<Vec<_>>(),
            vec![crate::derive::reflect::canon_clause(
                &crate::derive::parser_ext::parse_ext_program(SRC).expect("parse").rules()[0]
            )],
            "the surviving store must decode to the very clause that was reflected"
        );

        // …and the emptied database answers again once data comes back.
        let refill = vec![
            make_v2_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js"),
            make_v2_node("a.js->FUNCTION->g", "FUNCTION", "g", "a.js"),
        ];
        engine
            .commit_batch_ext(refill, vec![], &[], std::collections::HashMap::new(), &[])
            .expect("commit");
        engine.flush().expect("flush");
        let after = engine
            .eval_derive("", "p", crate::datalog::EvalLimits::none())
            .expect("store mode eval after clear");
        assert_eq!(
            after.len(),
            2,
            "the same program, re-run on the refilled graph"
        );
    }

}
