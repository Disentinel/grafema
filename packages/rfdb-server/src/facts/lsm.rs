//! Own-LSM [`FactStore`] adapter (P2, rofl-fact-model.md §10.4 row P2): the base-five
//! fact projection of today's `NodeRecordV2`/`EdgeRecordV2` over TODAY's format —
//! zero on-disk byte changes.
//!
//! Projection (§6.2/§6.3 restricted to the base-five vocabulary — the FULL
//! 141-predicate decomposition is the P6 converter's job, §10.3 step 2; keeping
//! today's vocabulary is what makes the equivalence differential against the
//! executor's `StorageView` meaningful, spec Q7):
//!
//! - `NodeRecordV2` → `node(Id, node_type)` AND `type(Id, node_type)` (both served
//!   by `eval_node` today); `attr(Id, k, v)` for the privileged fields
//!   (`name` / `file` / `semantic_id`, per today's five-way attr dispatch) and each
//!   non-reserved top-level metadata key.
//! - `EdgeRecordV2` → `edge(src, dst, edge_type)` and `incoming(dst, src, edge_type)`.
//! - FactRow synthesis (§10.1 conversion table, lossless): exactly ONE assertion per
//!   row — `author` ← interned `metadata["_source"]` (missing → `$legacy`), `tick` ←
//!   `metadata["_generation"]` (missing → 0), `tag` = Bool (prod segments are SGV2 v2
//!   with no tag columns, §2.2 MEASURED 359/359), `tx_created` = 0, `tx_invalidated`
//!   = `TX_OPEN`. `_source`/`_generation` move OUT of the attr projection into the
//!   assertion fields (§6.2 «0 доп. фактов» row) — never double-counted as attrs.
//!
//! Capability honesty (§7.1/§7.4): the adapter SERVES sorted runs and prefix scans
//! by materialize+sort over the snapshot-pinned `*_at` read surface — which is
//! exactly why it declares `sorted_runs: false` and `prefix_scan: false` (a flag
//! describes native physics, «без досортировки»).
//!
//! Column-coordinate note for `incoming` (ledger round-007, registered call C18):
//! the P1 catalog keys `incoming` as `[1,0]`/`[0,1]` — the reverse-run view of
//! `edge` expressed in EDGE column coordinates (`src`=0, `dst`=1; see the
//! `with_base_relations` comment: P3 folds it into `edge`'s reverse `SortOrder`).
//! This adapter serves `incoming` with the §6.2-normative tuple `(dst, src, type)`,
//! so it transposes those declared vectors into incoming-tuple coordinates
//! (`Forward` = `(dst, src)`-major, `Reverse` = `(src, dst)`-major).

use std::cmp::Ordering as CmpOrdering;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};

use smallvec::smallvec;

use super::{
    aid, fact_key_canon_bytes, fid, AssertBatch, Assertion, Capabilities, CommitToken,
    CompactionTier, FactGroup, FactKey, FactResult, FactRow, FactStore, FactStoreError,
    PerspectiveId, PerspectiveTable, Snapshot, SortOrder, SupersedeScope, PERSPECTIVE_MAIN,
    PERSPECTIVE_MAIN_NAME,
};
use crate::datalog::Value;
use crate::derive::canon::push_varint;
use crate::derive::catalog::{
    AuthorId, CatalogPredicateId, PredicateCatalog, PredicateDecl, PredicateStats,
};
use crate::derive::tag::{TagV2, TX_OPEN};
use crate::storage_v2::compaction::CompactionConfig;
use crate::storage_v2::manifest::{DurabilityMode, ManifestStore};
use crate::storage_v2::multi_shard::MultiShardStore;
use crate::storage_v2::read_snapshot::ReadSnapshot;
use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2};

/// The author name substituted for records with no `_source` (§10.1: 917 nodes /
/// 33 096 edges on the measured base; the projection must count them, not hide them).
pub const LEGACY_AUTHOR: &str = "$legacy";

/// Metadata keys that are ASSERTION fields, not attr facts (§6.2 «0 доп. фактов»).
const RESERVED_META_KEYS: [&str; 2] = ["_source", "_generation"];

/// Metadata-blob keys shadowed by the record COLUMNS (ledger round-008 R2): a
/// legacy blob may carry `name`/`file`/`semantic_id` (the JS reader strips them
/// on parse for the same reason), but today's read dispatch is column-
/// authoritative for these keys — `attr_to_query`/`snapshot_nodes_by_attr` map
/// `name`/`file` onto the record-column filter slots and the executor's `attr`
/// builtin serves them from `first_class_attr` columns. Emitting the blob copy
/// as a second attr fact would mint the SAME fid twice when the values agree
/// (violating §2.2 «no duplicates by construction», double-counting stats and
/// the state sha) and an unreadable phantom fact when they differ.
const COLUMN_META_KEYS: [&str; 3] = ["name", "file", "semantic_id"];

// ── Author interning ───────────────────────────────────────────────

#[derive(Debug, Default)]
struct AuthorTable {
    names: Vec<String>,
    ids: HashMap<String, AuthorId>,
}

impl AuthorTable {
    fn intern(&mut self, name: &str) -> AuthorId {
        if let Some(&id) = self.ids.get(name) {
            return id;
        }
        let id = AuthorId(u32::try_from(self.names.len()).expect("≤ u32 authors"));
        self.names.push(name.to_string());
        self.ids.insert(name.to_string(), id);
        id
    }

    fn name(&self, id: AuthorId) -> Option<&str> {
        self.names.get(id.0 as usize).map(String::as_str)
    }
}

// ── Snapshot payload ───────────────────────────────────────────────

/// The adapter's snapshot payload: the pinned MVCC read snapshot plus the lazily
/// built, memoized fid → row index (spec Q10 / ledger C14: first `get_fact` is
/// O(n), then O(1); §8.3 bans `get_fact` in the fixpoint hot loop, so the
/// first-touch cost is contractual, not accidental).
pub(crate) struct LsmSnapshotPayload {
    pub(crate) snap: ReadSnapshot,
    fid_index: OnceLock<HashMap<u128, FactRow>>,
    index_builds: AtomicU32,
}

// ── The adapter ────────────────────────────────────────────────────

/// [`FactStore`] over today's own-LSM (multi-shard columnar segments + manifest),
/// NO format change: reads delegate to the snapshot-pinned `*_at` surface, writes
/// delegate to the existing serial batch-commit path.
pub struct LsmFactStore {
    /// Lock order: `store` before `manifest`, everywhere.
    store: RwLock<MultiShardStore>,
    manifest: Mutex<ManifestStore>,
    catalog: PredicateCatalog,
    perspectives: RwLock<PerspectiveTable>,
    authors: RwLock<AuthorTable>,
    /// Base-five live counts, computed ONCE from a snapshot at the first
    /// `stats()` observation (ledger C13, refinement recorded in round-007:
    /// construction-time compute would observe the pre-commit empty state);
    /// `distinct`/`max_fanout` stay 0 with `updated_at_tx = 0` — the documented
    /// «not computed» sentinel (real maintenance is §10.4 P3).
    stats: OnceLock<HashMap<CatalogPredicateId, PredicateStats>>,
    /// Returned for ids declared after construction (zeroed, same sentinel).
    zero_stats: PredicateStats,
    base: BaseIds,
}

#[derive(Debug, Clone, Copy)]
struct BaseIds {
    node: CatalogPredicateId,
    ty: CatalogPredicateId,
    edge: CatalogPredicateId,
    incoming: CatalogPredicateId,
    attr: CatalogPredicateId,
}

impl LsmFactStore {
    /// Adapter over an in-memory store (tests / fixtures).
    pub fn ephemeral(shard_count: u16) -> Self {
        Self::from_parts(
            MultiShardStore::ephemeral(shard_count),
            ManifestStore::ephemeral(),
        )
    }

    /// Adapter over an existing on-disk database directory (read + write).
    pub fn open(path: &Path) -> FactResult<Self> {
        let manifest = ManifestStore::open(path).map_err(store_err)?;
        let store = MultiShardStore::open(path, &manifest).map_err(store_err)?;
        Ok(Self::from_parts(store, manifest))
    }

    /// Create a fresh on-disk database directory and adapt it.
    pub fn create(path: &Path, shard_count: u16) -> FactResult<Self> {
        std::fs::create_dir_all(path).map_err(|e| store_err(crate::error::GraphError::Io(e)))?;
        let store = MultiShardStore::create(path, shard_count).map_err(store_err)?;
        let manifest = ManifestStore::create(path).map_err(store_err)?;
        Ok(Self::from_parts(store, manifest))
    }

    /// Adapt an already-opened (store, manifest) pair. Base-five stats are
    /// computed once at the first `stats()` observation (ledger C13).
    pub fn from_parts(store: MultiShardStore, manifest: ManifestStore) -> Self {
        let catalog = PredicateCatalog::with_base_relations();
        let base = BaseIds {
            node: catalog.get("node").expect("base").id,
            ty: catalog.get("type").expect("base").id,
            edge: catalog.get("edge").expect("base").id,
            incoming: catalog.get("incoming").expect("base").id,
            attr: catalog.get("attr").expect("base").id,
        };
        Self {
            store: RwLock::new(store),
            manifest: Mutex::new(manifest),
            catalog,
            perspectives: RwLock::new(PerspectiveTable::new()),
            authors: RwLock::new(AuthorTable::default()),
            stats: OnceLock::new(),
            zero_stats: PredicateStats::default(),
            base,
        }
    }

    /// Intern a perspective name (tests use this to obtain a non-main id; only
    /// `main` has facts in P2 — §10.1).
    pub fn intern_perspective(&self, name: &str) -> PerspectiveId {
        self.perspectives.write().unwrap().intern(name)
    }

    /// Intern an author name for use in an [`AssertBatch`].
    pub fn intern_author(&self, name: &str) -> AuthorId {
        self.authors.write().unwrap().intern(name)
    }

    /// The interned name of `author`, if known to this store.
    pub fn author_name(&self, author: AuthorId) -> Option<String> {
        self.authors
            .read()
            .unwrap()
            .name(author)
            .map(str::to_string)
    }

    /// How many times the lazy fid index was built for `s` (test probe, C14).
    #[cfg(test)]
    pub(crate) fn fid_index_builds(&self, s: &Snapshot) -> u32 {
        self.payload(s)
            .expect("snapshot of this store")
            .index_builds
            .load(Ordering::SeqCst)
    }

    /// Test seam: commit records through the LEGACY serial path (the exact write
    /// path production uses), for the write-commutativity differential.
    #[cfg(test)]
    pub(crate) fn commit_legacy(
        &self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
    ) -> u64 {
        let mut store = self.store.write().unwrap();
        let mut manifest = self.manifest.lock().unwrap();
        let delta = store
            .commit_batch(nodes, edges, changed_files, HashMap::new(), &mut manifest)
            .expect("legacy commit");
        delta.manifest_version
    }

    /// Test seam: the pinned MVCC read snapshot inside `s` (for building the
    /// StorageView oracle on the IDENTICAL snapshot).
    #[cfg(test)]
    pub(crate) fn read_snapshot_of(&self, s: &Snapshot) -> ReadSnapshot {
        self.payload(s)
            .expect("snapshot of this store")
            .snap
            .clone()
    }

    /// Test seam: read access to the underlying store (oracle construction).
    #[cfg(test)]
    pub(crate) fn store_read(&self) -> std::sync::RwLockReadGuard<'_, MultiShardStore> {
        self.store.read().unwrap()
    }

    // ── internals ──────────────────────────────────────────────────

    fn payload<'a>(&self, s: &'a Snapshot) -> FactResult<&'a LsmSnapshotPayload> {
        s.payload_ref::<LsmSnapshotPayload>().ok_or(FactStoreError {
            code: "E-CAT-001",
            detail: "snapshot payload does not belong to this backend".to_string(),
        })
    }

    fn read_decl(&self, p: CatalogPredicateId) -> FactResult<&PredicateDecl> {
        // Unknown id → E-CAT-002 (P3, ledger round-007-pre C10: the P2 read path
        // rejected this with E-CAT-001 under the fixed pre-P3 code budget; P3 owns
        // the undeclared-predicate code and the migration happened with round-009).
        self.catalog.get_by_id(p).ok_or(FactStoreError {
            code: "E-CAT-002",
            detail: format!("unknown predicate id {p:?} (not declared in this catalog)"),
        })
    }

    /// The order's column sequence in TUPLE coordinates: the declared key run (or
    /// reverse run), then every remaining column ascending — a total, §9.2-canon
    /// order over rows. `incoming`'s declared vectors are transposed from edge
    /// coordinates (module docs / ledger C18).
    fn order_cols(&self, decl: &PredicateDecl, o: SortOrder) -> FactResult<Vec<usize>> {
        let declared: Vec<usize> = match o {
            SortOrder::Forward => decl.key_cols.iter().map(|&c| c as usize).collect(),
            SortOrder::Reverse => match &decl.reverse {
                Some(rev) => rev.iter().map(|&c| c as usize).collect(),
                // Typed error, never a silent empty run (I5).
                None => {
                    return Err(FactStoreError::cap(
                        "reverse-run",
                        format!("predicate '{}' declares reverse: None", decl.name),
                    ))
                }
            },
        };
        let mut cols: Vec<usize> = if decl.name == "incoming" {
            // Edge coords → incoming-tuple coords: src(0)↔dst(1).
            declared
                .iter()
                .map(|&c| match c {
                    0 => 1,
                    1 => 0,
                    other => other,
                })
                .collect()
        } else {
            declared
        };
        for i in 0..decl.arity as usize {
            if !cols.contains(&i) {
                cols.push(i);
            }
        }
        Ok(cols)
    }

    fn compute_base_stats(&self) -> HashMap<CatalogPredicateId, PredicateStats> {
        let store = self.store.read().unwrap();
        let snap = {
            let manifest = self.manifest.lock().unwrap();
            store.snapshot(&manifest)
        };
        let nodes = store.node_count_at(&snap) as u64;
        let edges = store.edge_count_at(&snap) as u64;
        let attrs = self.project_attr(&store, &snap).len() as u64;
        let mut stats = HashMap::new();
        for (id, count) in [
            (self.base.node, nodes),
            (self.base.ty, nodes),
            (self.base.edge, edges),
            (self.base.incoming, edges),
            (self.base.attr, attrs),
        ] {
            stats.insert(
                id,
                PredicateStats {
                    live_facts: count,
                    // One synthesized assertion per projected row (§10.1).
                    live_asserts: count,
                    distinct: Box::new([]),
                    max_fanout: 0,
                    updated_at_tx: 0,
                },
            );
        }
        stats
    }

    fn synth_row(&self, pred_name: &str, tuple: Vec<Value>, metadata: &str) -> FactRow {
        let (source, generation) = provenance(metadata);
        let author = self
            .authors
            .write()
            .unwrap()
            .intern(source.as_deref().unwrap_or(LEGACY_AUTHOR));
        let tuple: Box<[Value]> = tuple.into();
        let row_fid = fid(PERSPECTIVE_MAIN_NAME, pred_name, &tuple)
            .expect("projected tuples are Id/Str and always canonical");
        FactRow {
            key: FactKey {
                perspective: PERSPECTIVE_MAIN,
                predicate: self
                    .catalog
                    .get(pred_name)
                    .expect("base predicate registered")
                    .id,
                tuple,
            },
            fid: row_fid,
            assertions: smallvec![Assertion {
                fid: row_fid,
                author,
                tick: generation.unwrap_or(0),
                tag: TagV2::bool_one(),
                tx_created: 0,
                tx_invalidated: TX_OPEN,
            }],
        }
    }

    fn node_row(&self, pred_name: &str, rec: &NodeRecordV2) -> FactRow {
        self.synth_row(
            pred_name,
            vec![Value::Id(rec.id), Value::Str(rec.node_type.clone())],
            &rec.metadata,
        )
    }

    fn edge_row(&self, pred_name: &str, rec: &EdgeRecordV2) -> FactRow {
        let tuple = if pred_name == "incoming" {
            vec![
                Value::Id(rec.dst),
                Value::Id(rec.src),
                Value::Str(rec.edge_type.clone()),
            ]
        } else {
            vec![
                Value::Id(rec.src),
                Value::Id(rec.dst),
                Value::Str(rec.edge_type.clone()),
            ]
        };
        self.synth_row(pred_name, tuple, &rec.metadata)
    }

    /// C22's edge sibling (ledger round-008 R1): the keyed edge scans
    /// (`get_outgoing_edges_at` / `get_incoming_edges_at`) mirror the live
    /// shard's forward L0 order, so a re-asserted key surfaces its OLDEST
    /// record, while the full run (`iter_all_edges_at`) surfaces the NEWEST.
    /// One fid must carry ONE assertion — prefix_scan is a WINDOW of sorted_run
    /// (§7.2) at FactRow level, provenance included — so every keyed candidate
    /// is re-resolved through the newest-wins point path before synthesis.
    fn edge_winner(
        &self,
        store: &MultiShardStore,
        snap: &ReadSnapshot,
        candidate: EdgeRecordV2,
    ) -> EdgeRecordV2 {
        store
            .get_edge_at(snap, candidate.src, candidate.dst, &candidate.edge_type)
            // The candidate key is live in this snapshot by construction (the
            // keyed scan shares segments + tombstones with the point path), so
            // the lookup always finds a record; the fallback keeps the read
            // path panic-free without masking anything — it is the same key.
            .unwrap_or(candidate)
    }

    /// The attr/3 facts of one node record: privileged fields (`name` / `file` /
    /// `semantic_id`, when non-empty — matching today's Option-shaped attr
    /// dispatch) plus every non-reserved top-level metadata key with a scalar
    /// value (string/number/bool, stringified exactly as today's metadata attr
    /// path does). `_source`/`_generation` are NEVER attrs (§6.2); blob copies
    /// of the column-authoritative keys are skipped ([`COLUMN_META_KEYS`]).
    fn attr_rows_for(&self, rec: &NodeRecordV2) -> Vec<FactRow> {
        let mut rows = Vec::new();
        let mut push = |key: &str, value: String| {
            rows.push(self.synth_row(
                "attr",
                vec![
                    Value::Id(rec.id),
                    Value::Str(key.to_string()),
                    Value::Str(value),
                ],
                &rec.metadata,
            ));
        };
        if !rec.name.is_empty() {
            push("name", rec.name.clone());
        }
        if !rec.file.is_empty() {
            push("file", rec.file.clone());
        }
        if !rec.semantic_id.is_empty() {
            push("semantic_id", rec.semantic_id.clone());
        }
        if let Ok(serde_json::Value::Object(map)) =
            serde_json::from_str::<serde_json::Value>(&rec.metadata)
        {
            for (k, v) in &map {
                if RESERVED_META_KEYS.contains(&k.as_str())
                    || COLUMN_META_KEYS.contains(&k.as_str())
                {
                    continue;
                }
                if let Some(s) = json_scalar_to_string(v) {
                    push(k, s);
                }
            }
        }
        rows
    }

    fn project_attr(&self, store: &MultiShardStore, snap: &ReadSnapshot) -> Vec<FactRow> {
        store
            .find_nodes_at(snap, None, None)
            .iter()
            .flat_map(|rec| self.attr_rows_for(rec))
            .collect()
    }

    /// All main-perspective rows of `decl` in this snapshot — the base-five
    /// projection; any OTHER (declared) predicate has zero facts in P2, which is
    /// an honest empty relation, not an error.
    fn project_predicate(
        &self,
        store: &MultiShardStore,
        snap: &ReadSnapshot,
        decl: &PredicateDecl,
    ) -> Vec<FactRow> {
        match decl.name.as_str() {
            "node" | "type" => store
                .find_nodes_at(snap, None, None)
                .iter()
                .map(|rec| self.node_row(&decl.name, rec))
                .collect(),
            "edge" | "incoming" => store
                .iter_all_edges_at(snap)
                .iter()
                .map(|rec| self.edge_row(&decl.name, rec))
                .collect(),
            "attr" => self.project_attr(store, snap),
            _ => Vec::new(),
        }
    }

    /// Live aids superseded in `snap` — the anti-join build side of §2.4. The
    /// projection speaks only the base five, so `supersedes` is PROVABLY empty
    /// over P2 data; P4 populates it. This is the real algorithm run on real
    /// (degenerate) data, not a stub.
    fn superseded_aids(&self, store: &MultiShardStore, snap: &ReadSnapshot) -> HashSet<u128> {
        let mut set = HashSet::new();
        if let Some(decl) = self.catalog.get("supersedes") {
            for row in self.project_predicate(store, snap, decl) {
                if let Some(Value::Id(dead_aid)) = row.key.tuple.get(1) {
                    set.insert(*dead_aid);
                }
            }
        }
        set
    }

    fn fid_index<'a>(&self, payload: &'a LsmSnapshotPayload) -> &'a HashMap<u128, FactRow> {
        payload.fid_index.get_or_init(|| {
            payload.index_builds.fetch_add(1, Ordering::SeqCst);
            let store = self.store.read().unwrap();
            let mut index = HashMap::new();
            for decl in self.catalog.iter() {
                for row in self.project_predicate(&store, &payload.snap, decl) {
                    index.insert(row.fid, row);
                }
            }
            index
        })
    }
}

/// Delegated backend failure (I/O, lock, commit). The doc's §7.2 leaves the
/// `Result` error unspecified and its taxonomy has no backend-failure code;
/// `E-STORE-001` is the P2 envelope for errors PROPAGATED from the store layer
/// (never minted for a FactStore-level rejection — those use the four taxonomy
/// codes). Registered in ledger round-007 as a necessary addition.
fn store_err(e: crate::error::GraphError) -> FactStoreError {
    FactStoreError {
        code: "E-STORE-001",
        detail: format!("delegated store operation failed: {e}"),
    }
}

/// `_source` / `_generation` of a record's metadata blob (§10.1). `_generation`
/// tolerates both JSON number and numeric string (writers vary).
fn provenance(metadata: &str) -> (Option<String>, Option<u64>) {
    if metadata.is_empty() {
        return (None, None);
    }
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(metadata)
    else {
        return (None, None);
    };
    let source = map
        .get("_source")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let generation = map.get("_generation").and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
    });
    (source, generation)
}

/// Scalar JSON → string, exactly like today's metadata attr path (`value_to_string`
/// in the query engine's utils): String verbatim, Number/Bool via `to_string`,
/// Object/Array/Null → not an attr.
fn json_scalar_to_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Object(_) | serde_json::Value::Array(_) | serde_json::Value::Null => {
            None
        }
    }
}

fn sort_rows(rows: &mut [FactRow], cols: &[usize]) {
    rows.sort_by(|a, b| {
        for &c in cols {
            // §9.2 canon total order (P1 `Ord for Value`) — the P2-defined run
            // order, deliberately DISTINCT from the executor's exec order (C4).
            let ord = a.key.tuple[c].cmp(&b.key.tuple[c]);
            if ord != CmpOrdering::Equal {
                return ord;
            }
        }
        CmpOrdering::Equal
    });
}

impl FactStore for LsmFactStore {
    fn catalog(&self) -> &PredicateCatalog {
        &self.catalog
    }

    fn declare(&mut self, decl: PredicateDecl) -> FactResult<CatalogPredicateId> {
        Ok(self.catalog.declare(decl)?)
    }

    /// §7.4's own-LSM column, each flag grounded in live code (per-flag evidence
    /// tests below).
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // L0 segments are written UNSORTED (write_buffer docs) and there is
            // no read-side merge; this adapter materializes and sorts — which is
            // exactly why the native flag is false.
            sorted_runs: false,
            // get_node_at / get_outgoing_edges_at are bloom-gate + linear scan,
            // even over the sorted L1 (§7.4; no binary search on the snapshot path).
            prefix_scan: false,
            // compaction tag_fold exists (⊕ per semiring). Its fold key must
            // change for assertion physics — a P4/P5 blocker, not a P2 falsifier.
            merge_operator: true,
            // begin/end_bulk_load exist (deferred-durability ingest + barrier).
            bulk_ingest: true,
            // ReadSnapshot MVCC: every read is version-pinned (*_at surface).
            snapshot_isolation: true,
            // No tick query machinery exists (§2.8).
            as_of_tick: false,
            // No compression anywhere in the tree (§7.4).
            compression: false,
            // No reshard code; shard_count survives clear_durable.
            reshard: false,
        }
    }

    fn snapshot(&self) -> Snapshot {
        let store = self.store.read().unwrap();
        let manifest = self.manifest.lock().unwrap();
        Snapshot::new(Box::new(LsmSnapshotPayload {
            snap: store.snapshot(&manifest),
            fid_index: OnceLock::new(),
            index_builds: AtomicU32::new(0),
        }))
    }

    fn sorted_run<'a>(
        &'a self,
        s: &'a Snapshot,
        p: CatalogPredicateId,
        persp: PerspectiveId,
        o: SortOrder,
    ) -> FactResult<Box<dyn Iterator<Item = FactRow> + 'a>> {
        self.prefix_scan(s, p, persp, o, &[])
    }

    fn prefix_scan<'a>(
        &'a self,
        s: &'a Snapshot,
        p: CatalogPredicateId,
        persp: PerspectiveId,
        o: SortOrder,
        prefix: &[Value],
    ) -> FactResult<Box<dyn Iterator<Item = FactRow> + 'a>> {
        let decl = self.read_decl(p)?;
        let cols = self.order_cols(decl, o)?; // typed E-CAP before any emptiness
        let payload = self.payload(s)?;
        // §5.4a exact-match: a perspective with no facts answers nothing. Only
        // main has facts in P2 (§10.1) — checked AFTER order/catalog validation
        // so errors stay typed regardless of perspective.
        if persp != PERSPECTIVE_MAIN {
            return Ok(Box::new(std::iter::empty()));
        }
        if prefix.len() > cols.len() {
            return Ok(Box::new(std::iter::empty()));
        }
        let store = self.store.read().unwrap();
        let snap = &payload.snap;
        // Targeted delegations for bound leading keys (same *_at surface the
        // executor's view uses); everything else materializes the projection.
        let mut rows: Vec<FactRow> = match (decl.name.as_str(), o, prefix.first()) {
            ("node" | "type", SortOrder::Forward, Some(Value::Id(id))) => store
                .get_node_at(snap, *id)
                .map(|rec| vec![self.node_row(&decl.name, &rec)])
                .unwrap_or_default(),
            ("type", SortOrder::Reverse, Some(Value::Str(ty))) => {
                // §2.3 conflict class: the store's type-filtered scan filters
                // BEFORE newest-wins dedup, so a duplicate-id record whose
                // WINNER has a different type leaks through (39 ids on the
                // measured base). The fact relation must stay coherent —
                // prefix_scan is a WINDOW of sorted_run (§7.2), and sorted_run
                // projects winners — so candidates are resolved through the
                // winner-picking point path and shadowed records are dropped
                // (ledger round-007 C22).
                let mut rows = Vec::new();
                let mut seen_ids = HashSet::new();
                for rec in store.find_nodes_at(snap, Some(ty), None) {
                    if !seen_ids.insert(rec.id) {
                        continue;
                    }
                    if let Some(winner) = store.get_node_at(snap, rec.id) {
                        if winner.node_type == *ty {
                            rows.push(self.node_row("type", &winner));
                        }
                    }
                }
                rows
            }
            ("attr", SortOrder::Forward, Some(Value::Id(id))) => store
                .get_node_at(snap, *id)
                .map(|rec| self.attr_rows_for(&rec))
                .unwrap_or_default(),
            // The four keyed edge paths re-resolve every candidate through the
            // newest-wins point lookup so one fid always yields one Assertion
            // (edge_winner docs; ledger round-008 R1).
            ("edge", SortOrder::Forward, Some(Value::Id(src))) => store
                .get_outgoing_edges_at(snap, *src, None)
                .into_iter()
                .map(|rec| self.edge_row("edge", &self.edge_winner(&store, snap, rec)))
                .collect(),
            ("edge", SortOrder::Reverse, Some(Value::Id(dst))) => store
                .get_incoming_edges_at(snap, *dst, None)
                .into_iter()
                .map(|rec| self.edge_row("edge", &self.edge_winner(&store, snap, rec)))
                .collect(),
            ("incoming", SortOrder::Forward, Some(Value::Id(dst))) => store
                .get_incoming_edges_at(snap, *dst, None)
                .into_iter()
                .map(|rec| self.edge_row("incoming", &self.edge_winner(&store, snap, rec)))
                .collect(),
            ("incoming", SortOrder::Reverse, Some(Value::Id(src))) => store
                .get_outgoing_edges_at(snap, *src, None)
                .into_iter()
                .map(|rec| self.edge_row("incoming", &self.edge_winner(&store, snap, rec)))
                .collect(),
            _ => self.project_predicate(&store, snap, decl),
        };
        drop(store);
        // The general prefix window (also re-verifies the fast paths' key).
        rows.retain(|row| {
            prefix
                .iter()
                .enumerate()
                .all(|(i, want)| &row.key.tuple[cols[i]] == want)
        });
        sort_rows(&mut rows, &cols);
        Ok(Box::new(rows.into_iter()))
    }

    fn get_fact(&self, s: &Snapshot, fid: u128) -> Option<FactRow> {
        let payload = self.payload(s).ok()?;
        self.fid_index(payload).get(&fid).cloned()
    }

    fn tuple(&self, s: &Snapshot, fid: u128) -> Option<Box<[Value]>> {
        self.get_fact(s, fid).map(|row| row.key.tuple)
    }

    fn live_filter<'a>(
        &'a self,
        s: &'a Snapshot,
        rows: Box<dyn Iterator<Item = FactRow> + 'a>,
    ) -> Box<dyn Iterator<Item = FactRow> + 'a> {
        // The REAL §2.4 anti-join, degenerate-but-exact over P2 data: the
        // supersedes relation is provably empty (base-five projection), so every
        // TX_OPEN assertion survives — but rule 1 (tx_invalidated cache never
        // lies dead-wards) and the aid anti-join both run for real.
        let superseded = match self.payload(s) {
            Ok(payload) => {
                let store = self.store.read().unwrap();
                self.superseded_aids(&store, &payload.snap)
            }
            Err(_) => HashSet::new(),
        };
        Box::new(rows.filter_map(move |mut row| {
            row.assertions.retain(|a| {
                a.tx_invalidated == TX_OPEN && !superseded.contains(&aid(a.fid, a.author, a.tick))
            });
            if row.assertions.is_empty() {
                None
            } else {
                Some(row)
            }
        }))
    }

    fn resolve_functional(
        &self,
        _s: &Snapshot,
        _p: CatalogPredicateId,
        _persp: PerspectiveId,
        _subject: u128,
    ) -> FactResult<Option<(FactRow, Vec<FactKey>)>> {
        // §10.4 assigns Functional resolution (+ conflict/5, E-FUNC-001) to P5.
        Err(FactStoreError::cap(
            "functional-resolution",
            "Functional cardinality resolution is phase P5 (§10.4); P2 must not fake it",
        ))
    }

    fn assert_batch(&self, b: AssertBatch) -> FactResult<CommitToken> {
        // Gate 2 (§10.1): perspective is unrepresentable in today's format.
        if b.perspective != PERSPECTIVE_MAIN {
            return Err(FactStoreError::cap(
                "perspectives",
                "today's record format cannot represent a non-main perspective (§10.1)",
            ));
        }
        let author_name = self.author_name(b.author).ok_or(FactStoreError {
            code: "E-CAT-001",
            detail: format!(
                "unknown author id {:?} (intern via intern_author first)",
                b.author
            ),
        })?;

        // Gate 1 (round-005-pre H4): the inherited E-VAL boundary — validate every
        // tuple value canonically (recursively through Term) and assemble ALL
        // records BEFORE any store mutation, so a violation aborts the whole
        // batch pre-commit with the store unchanged.
        let mut nodes: Vec<NodeRecordV2> = Vec::new();
        let mut edges: Vec<EdgeRecordV2> = Vec::new();
        for group in &b.groups {
            match group {
                FactGroup::Node { facts } => {
                    nodes.push(self.build_node_record(facts, &author_name, b.tick)?)
                }
                FactGroup::Edge { fact } => {
                    edges.push(self.build_edge_record(fact, &author_name, b.tick)?)
                }
            }
        }
        if nodes.is_empty() && edges.is_empty() {
            // Nothing to publish; the current version is the token.
            let version = self.manifest.lock().unwrap().current().version;
            return Ok(CommitToken { version });
        }
        // Delegate to the existing serial commit path, ADDITIVE (empty
        // changed_files: no tombstoning) — no new on-disk bytes anywhere.
        let mut store = self.store.write().unwrap();
        let mut manifest = self.manifest.lock().unwrap();
        let delta = store
            .commit_batch(nodes, edges, &[], HashMap::new(), &mut manifest)
            .map_err(store_err)?;
        Ok(CommitToken {
            version: delta.manifest_version,
        })
    }

    fn supersede(&self, _scope: SupersedeScope, _at_tick: u64) -> FactResult<CommitToken> {
        // §10.4 assigns supersedes + E-SUP-001 to P4. Delegating to tombstones
        // would SILENTLY change semantics when P4 lands (audit-trail loss) — loud
        // rejection instead.
        Err(FactStoreError::cap(
            "supersession",
            "supersedes/E-SUP-001 are phase P4 (§10.4); tombstone emulation is forbidden",
        ))
    }

    fn begin_bulk_load(&mut self) -> FactResult<()> {
        // Deferred durability until the end_bulk_load barrier (the engine's
        // MVCC C2 contract).
        self.manifest
            .lock()
            .unwrap()
            .set_durability(DurabilityMode::Relaxed)
            .map_err(store_err)
    }

    fn end_bulk_load(&mut self) -> FactResult<()> {
        // Flush buffered data, run the durable barrier, restore strictness —
        // the same sequence the engine's end_bulk_load performs (minus its
        // compaction-policy knobs, which are engine-side tuning, not the
        // durability contract).
        {
            let store = self.store.get_mut().unwrap();
            let manifest = self.manifest.get_mut().unwrap();
            store.flush_all(manifest).map_err(store_err)?;
            manifest.make_durable().map_err(store_err)?;
            manifest
                .set_durability(DurabilityMode::Strict)
                .map_err(store_err)?;
        }
        Ok(())
    }

    fn compact(&self, p: Option<CatalogPredicateId>, tier: CompactionTier) -> FactResult<()> {
        if let Some(p) = p {
            // Today's segment vocabulary is exactly {nodes, edges} — a
            // per-predicate compaction target does not exist (§7.4).
            let name = self
                .catalog
                .get_by_id(p)
                .map(|d| d.name.clone())
                .unwrap_or_else(|| format!("{p:?}"));
            return Err(FactStoreError::cap(
                "per-predicate-compaction",
                format!(
                    "segment vocabulary is {{nodes, edges}}; cannot compact predicate '{name}'"
                ),
            ));
        }
        let config = match tier {
            CompactionTier::Tiered => CompactionConfig::default(),
            CompactionTier::FullMerge => CompactionConfig {
                segment_threshold: 1,
                l1_fanout: f64::INFINITY,
            },
        };
        let mut store = self.store.write().unwrap();
        let mut manifest = self.manifest.lock().unwrap();
        store
            .compact(&mut manifest, &config)
            .map(|_| ())
            .map_err(store_err)
    }

    fn stats(&self, p: CatalogPredicateId) -> &PredicateStats {
        self.stats
            .get_or_init(|| self.compute_base_stats())
            .get(&p)
            .unwrap_or(&self.zero_stats)
    }

    fn canonical_state_sha(&self, s: &Snapshot) -> [u8; 32] {
        // Contractual panic (trait doc): a foreign snapshot is a programming
        // error and a state sha has no honest degraded answer.
        let payload = self
            .payload(s)
            .expect("canonical_state_sha requires a snapshot of this store");
        let store = self.store.read().unwrap();
        let snap = &payload.snap;

        // 1. Every live base-five fact (the projected logical state), through the
        //    same §2.4 liveness rules live_filter applies.
        let superseded = self.superseded_aids(&store, snap);
        let mut rows: Vec<FactRow> = Vec::new();
        for decl in self.catalog.iter() {
            rows.extend(self.project_predicate(&store, snap, decl));
        }
        rows.retain_mut(|row| {
            row.assertions.retain(|a| {
                a.tx_invalidated == TX_OPEN && !superseded.contains(&aid(a.fid, a.author, a.tick))
            });
            !row.assertions.is_empty()
        });
        drop(store);

        // 2. §9.2 canonical order: perspective name, predicate name, tuple canon
        //    bytes — never interned ids.
        let authors = self.authors.read().unwrap();
        let mut entries: Vec<(String, Vec<u8>, FactRow)> = rows
            .into_iter()
            .map(|row| {
                let pred_name = self
                    .catalog
                    .get_by_id(row.key.predicate)
                    .expect("projected predicate is declared")
                    .name
                    .clone();
                let mut tuple_bytes = Vec::new();
                for v in row.key.tuple.iter() {
                    crate::derive::canon::canon_bytes(v, &mut tuple_bytes)
                        .expect("projected tuples are canonical");
                }
                (pred_name, tuple_bytes, row)
            })
            .collect();
        entries.sort_by(|a, b| {
            a.0.as_bytes()
                .cmp(b.0.as_bytes())
                .then_with(|| a.1.cmp(&b.1))
        });

        // 3. Data-derived author ranks (ledger round-007-pre C9): the runtime
        //    interned u32 is process/order-dependent — the sha uses the rank of
        //    the author NAME in the byte-sorted live-author set instead.
        let mut live_author_names: Vec<&str> = entries
            .iter()
            .flat_map(|(_, _, row)| row.assertions.iter())
            .map(|a| authors.name(a.author).expect("interned during projection"))
            .collect();
        live_author_names.sort_unstable();
        live_author_names.dedup();
        let rank: HashMap<&str, u32> = live_author_names
            .iter()
            .enumerate()
            .map(|(i, &n)| (n, i as u32))
            .collect();

        // 4. tick component = max live assertion tick (process-invariant, derived
        //    from the data — spec Q8; the doc leaves the pre-P4 value open).
        let max_tick = entries
            .iter()
            .flat_map(|(_, _, row)| row.assertions.iter())
            .map(|a| a.tick)
            .max()
            .unwrap_or(0);

        // 5. §9.1 formula.
        let mut input: Vec<u8> = Vec::new();
        input.extend_from_slice(b"ROFL-STATE-v1\n");
        push_varint(&mut input, max_tick);
        for (pred_name, _, row) in &entries {
            fact_key_canon_bytes(PERSPECTIVE_MAIN_NAME, pred_name, &row.key.tuple, &mut input)
                .expect("projected tuples are canonical");
            push_varint(&mut input, row.assertions.len() as u64);
            let mut asserts: Vec<&Assertion> = row.assertions.iter().collect();
            asserts.sort_by_key(|a| (rank[authors.name(a.author).expect("interned")], a.tick));
            for a in asserts {
                input.extend_from_slice(
                    &rank[authors.name(a.author).expect("interned")].to_le_bytes(),
                );
                input.extend_from_slice(&a.tick.to_le_bytes());
                input.extend_from_slice(&a.tag.semiring_id.to_le_bytes());
                push_varint(&mut input, a.tag.bytes.len() as u64);
                input.extend_from_slice(&a.tag.bytes);
            }
        }
        *blake3::hash(&input).as_bytes()
    }
}

impl LsmFactStore {
    /// Assemble one node record from a record-shaped group: exactly one `node/2`
    /// fact (subject id + type) plus optional `attr/3` facts for the SAME subject
    /// (`semantic_id` / `name` / `file` land in their record columns, everything
    /// else in the metadata blob). `author`/`tick` are stamped as
    /// `_source`/`_generation` — the exact inverse of the read projection.
    fn build_node_record(
        &self,
        facts: &[super::GroupFact],
        author_name: &str,
        tick: u64,
    ) -> FactResult<NodeRecordV2> {
        // The whole-batch E-VAL gate first (round-005-pre H4).
        for fact in facts {
            for v in fact.tuple.iter() {
                crate::derive::canon::validate_canonical(v)?;
            }
        }
        let mut node_fact: Option<&super::GroupFact> = None;
        let mut attrs: Vec<&super::GroupFact> = Vec::new();
        for fact in facts {
            if fact.predicate == self.base.node {
                if node_fact.is_some() {
                    return Err(FactStoreError::cap(
                        "record-vocabulary",
                        "a node group must contain exactly one node/2 fact (two found)",
                    ));
                }
                node_fact = Some(fact);
            } else if fact.predicate == self.base.attr {
                attrs.push(fact);
            } else {
                let name = self
                    .catalog
                    .get_by_id(fact.predicate)
                    .map(|d| d.name.clone())
                    .unwrap_or_else(|| format!("{:?}", fact.predicate));
                return Err(FactStoreError::cap(
                    "record-vocabulary",
                    format!(
                        "predicate '{name}' is not representable in the P2 record projection \
                         (node groups accept node/2 + attr/3; type/2 is a derived view of node/2)"
                    ),
                ));
            }
        }
        let Some(node_fact) = node_fact else {
            // §2.1: sub-record granularity — a lone attr on an (existing) entity —
            // is exactly what today's format cannot replace («половину записи
            // сегодня заменить нельзя»). P4/P6 deliver it; P2 must not fake it.
            return Err(FactStoreError::cap(
                "assertion-granularity",
                "attr/3 without its node/2 record is sub-record granularity (§2.1); \
                 whole-record groups only in P2",
            ));
        };
        let (id, node_type) = match &node_fact.tuple[..] {
            [Value::Id(id), Value::Str(ty)] => (*id, ty.clone()),
            other => {
                return Err(FactStoreError::cap(
                    "record-vocabulary",
                    format!("node/2 tuple must be [Id, Str], got {other:?}"),
                ))
            }
        };
        let mut semantic_id = String::new();
        let mut name = String::new();
        let mut file = String::new();
        let mut meta = serde_json::Map::new();
        for attr in &attrs {
            let (subject, key, value) = match &attr.tuple[..] {
                [Value::Id(s), Value::Str(k), Value::Str(v)] => (*s, k.as_str(), v.clone()),
                other => {
                    return Err(FactStoreError::cap(
                        "record-vocabulary",
                        format!(
                            "attr/3 tuple must be [Id, Str, Str] to round-trip through the \
                             record metadata blob, got {other:?}"
                        ),
                    ))
                }
            };
            if subject != id {
                return Err(FactStoreError::cap(
                    "assertion-granularity",
                    format!(
                        "attr subject {subject} differs from the group's node subject {id} — \
                         an attr detached from its record is sub-record granularity"
                    ),
                ));
            }
            if RESERVED_META_KEYS.contains(&key) {
                return Err(FactStoreError::cap(
                    "assertion-granularity",
                    format!(
                        "'{key}' is an assertion field (author/tick), not an attr (§6.2); \
                         asserting it directly would double-count provenance"
                    ),
                ));
            }
            match key {
                "semantic_id" => semantic_id = value,
                "name" => name = value,
                "file" => file = value,
                _ => {
                    if meta
                        .insert(key.to_string(), serde_json::Value::String(value))
                        .is_some()
                    {
                        return Err(FactStoreError::cap(
                            "record-vocabulary",
                            format!("duplicate attr key '{key}' in one node group"),
                        ));
                    }
                }
            }
        }
        meta.insert(
            "_source".to_string(),
            serde_json::Value::String(author_name.to_string()),
        );
        meta.insert("_generation".to_string(), serde_json::Value::from(tick));
        Ok(NodeRecordV2 {
            semantic_id,
            id,
            node_type,
            name,
            file,
            content_hash: 0,
            metadata: serde_json::Value::Object(meta).to_string(),
        })
    }

    /// Assemble one edge record from an `edge/3` fact, stamping
    /// `_source`/`_generation` from the batch author/tick.
    fn build_edge_record(
        &self,
        fact: &super::GroupFact,
        author_name: &str,
        tick: u64,
    ) -> FactResult<EdgeRecordV2> {
        for v in fact.tuple.iter() {
            crate::derive::canon::validate_canonical(v)?;
        }
        if fact.predicate != self.base.edge {
            let name = self
                .catalog
                .get_by_id(fact.predicate)
                .map(|d| d.name.clone())
                .unwrap_or_else(|| format!("{:?}", fact.predicate));
            return Err(FactStoreError::cap(
                "record-vocabulary",
                format!(
                    "edge groups accept edge/3 only (incoming/3 is its reverse view), got '{name}'"
                ),
            ));
        }
        let (src, dst, edge_type) = match &fact.tuple[..] {
            [Value::Id(src), Value::Id(dst), Value::Str(ty)] => (*src, *dst, ty.clone()),
            other => {
                return Err(FactStoreError::cap(
                    "record-vocabulary",
                    format!("edge/3 tuple must be [Id, Id, Str], got {other:?}"),
                ))
            }
        };
        let mut meta = serde_json::Map::new();
        meta.insert(
            "_source".to_string(),
            serde_json::Value::String(author_name.to_string()),
        );
        meta.insert("_generation".to_string(), serde_json::Value::from(tick));
        Ok(EdgeRecordV2 {
            src,
            dst,
            edge_type,
            metadata: serde_json::Value::Object(meta).to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::catalog::{Cardinality, PhysStrategy, TemporalScope};
    use crate::facts::SubjectSet;

    // ── fixture ────────────────────────────────────────────────────

    fn meta_json(source: Option<&str>, generation: Option<serde_json::Value>) -> String {
        let mut map = serde_json::Map::new();
        if let Some(s) = source {
            map.insert("_source".into(), serde_json::Value::String(s.into()));
        }
        if let Some(g) = generation {
            map.insert("_generation".into(), g);
        }
        serde_json::Value::Object(map).to_string()
    }

    fn node_rec(id: u128, ty: &str, name: &str, file: &str, metadata: &str) -> NodeRecordV2 {
        NodeRecordV2 {
            semantic_id: format!("{file}->{ty}->{name}"),
            id,
            node_type: ty.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: metadata.to_string(),
        }
    }

    fn edge_rec(src: u128, dst: u128, ty: &str, metadata: &str) -> EdgeRecordV2 {
        EdgeRecordV2 {
            src,
            dst,
            edge_type: ty.to_string(),
            metadata: metadata.to_string(),
        }
    }

    /// Fixture: multi-type nodes, edge metadata, numeric/bool/nested metadata
    /// values, a `column: 0` value, and records MISSING `_source`/`_generation`
    /// (the `$legacy` path).
    fn fixture_records() -> (Vec<NodeRecordV2>, Vec<EdgeRecordV2>) {
        let n1 = {
            let mut m: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
            m.insert("_source".into(), "analyzer".into());
            m.insert("_generation".into(), 3u64.into());
            m.insert("line".into(), 5u64.into());
            m.insert("async".into(), true.into());
            m.insert("column".into(), 0u64.into());
            m.insert("nested".into(), serde_json::json!({"a": 1}));
            node_rec(
                11,
                "FUNCTION",
                "fn1",
                "a/f.js",
                &serde_json::Value::Object(m).to_string(),
            )
        };
        let n2 = node_rec(
            22,
            "FUNCTION",
            "fn2",
            "a/f.js",
            &meta_json(Some("enricher"), Some(7u64.into())),
        );
        // No metadata at all → $legacy / tick 0.
        let n3 = node_rec(33, "CLASS", "", "b/g.js", "");
        // String-typed generation, no source.
        let n4 = node_rec(
            44,
            "CLASS",
            "cls",
            "b/g.js",
            &meta_json(None, Some("9".into())),
        );
        let e1 = edge_rec(
            11,
            22,
            "CALLS",
            &meta_json(Some("analyzer"), Some(3u64.into())),
        );
        let e2 = edge_rec(11, 33, "CONTAINS", "");
        let e3 = edge_rec(22, 33, "CALLS", &meta_json(Some("enricher"), None));
        let e4 = edge_rec(
            33,
            44,
            "IMPORTS",
            &meta_json(Some("analyzer"), Some(3u64.into())),
        );
        (vec![n1, n2, n3, n4], vec![e1, e2, e3, e4])
    }

    fn fixture_store() -> LsmFactStore {
        let fs = LsmFactStore::ephemeral(2);
        let (nodes, edges) = fixture_records();
        fs.commit_legacy(nodes, edges, &[]);
        fs
    }

    fn base_id(fs: &LsmFactStore, name: &str) -> CatalogPredicateId {
        fs.catalog().get(name).expect("base predicate").id
    }

    fn collect<'a>(it: FactResult<Box<dyn Iterator<Item = FactRow> + 'a>>) -> Vec<FactRow> {
        it.expect("readable run").collect()
    }

    // ── capability vector: one test per flag, named for its evidence ──

    #[test]
    fn sorted_runs_false_because_l0_unsorted_no_read_side_merge() {
        assert!(!fixture_store().capabilities().sorted_runs);
    }

    #[test]
    fn prefix_scan_false_because_bloom_gate_plus_linear_scan() {
        assert!(!fixture_store().capabilities().prefix_scan);
    }

    #[test]
    fn merge_operator_true_because_compaction_tag_fold_exists() {
        assert!(fixture_store().capabilities().merge_operator);
    }

    #[test]
    fn bulk_ingest_true_because_begin_end_bulk_load_exist() {
        assert!(fixture_store().capabilities().bulk_ingest);
    }

    #[test]
    fn snapshot_isolation_true_because_read_snapshot_mvcc_at_path() {
        assert!(fixture_store().capabilities().snapshot_isolation);
    }

    #[test]
    fn as_of_tick_false_because_no_tick_query_machinery() {
        assert!(!fixture_store().capabilities().as_of_tick);
    }

    #[test]
    fn compression_false_because_none_in_tree() {
        assert!(!fixture_store().capabilities().compression);
    }

    #[test]
    fn reshard_false_because_no_code_and_shard_count_survives_clear() {
        assert!(!fixture_store().capabilities().reshard);
    }

    // ── E-VAL boundary at assert_batch (round-005-pre H4 inheritance) ──

    fn node_group(fs: &LsmFactStore, id: u128, ty: &str, attrs: &[(&str, Value)]) -> FactGroup {
        let mut facts = vec![super::super::GroupFact {
            predicate: base_id(fs, "node"),
            tuple: vec![Value::Id(id), Value::Str(ty.to_string())].into(),
        }];
        for (k, v) in attrs {
            facts.push(super::super::GroupFact {
                predicate: base_id(fs, "attr"),
                tuple: vec![Value::Id(id), Value::Str(k.to_string()), v.clone()].into(),
            });
        }
        FactGroup::Node { facts }
    }

    fn batch(fs: &LsmFactStore, groups: Vec<FactGroup>) -> AssertBatch {
        AssertBatch {
            perspective: PERSPECTIVE_MAIN,
            author: fs.intern_author("tester"),
            tick: 42,
            groups,
        }
    }

    /// Each non-canonical value aborts the WHOLE batch pre-commit: the state sha
    /// is byte-identical before and after the rejected call.
    #[test]
    fn assert_batch_e_val_aborts_whole_batch_store_unchanged() {
        let fs = fixture_store();
        let s = fs.snapshot();
        let sha_before = fs.canonical_state_sha(&s);
        let cases: Vec<(Value, &str)> = vec![
            // BigInt fitting i64 (V1) → E-VAL-001.
            (Value::BigInt([1, 2, 3].into()), "E-VAL-001"),
            // Non-minimal BigInt encoding (V2) → E-VAL-001 (leading sign-extension
            // byte on a 9-byte payload that minimizes to 8).
            (
                Value::BigInt([0, 0, 1, 2, 3, 4, 5, 6, 7].into()),
                "E-VAL-001",
            ),
            // -0.0 (V3) → E-VAL-002.
            (Value::Float(-0.0), "E-VAL-002"),
            // Signaling-NaN payload (non-canonical bits) → E-VAL-002.
            (
                Value::Float(f64::from_bits(0x7ff0000000000001)),
                "E-VAL-002",
            ),
            // Payload-carrying quiet NaN (still non-canonical) → E-VAL-002.
            (
                Value::Float(f64::from_bits(0x7ff8000000000123)),
                "E-VAL-002",
            ),
        ];
        for (bad, code) in cases {
            // A good group FOLLOWED by the bad one: the whole batch must abort.
            let good = node_group(&fs, 100, "FUNCTION", &[]);
            let bad_group = node_group(&fs, 101, "FUNCTION", &[("payload", bad.clone())]);
            let err = fs
                .assert_batch(batch(&fs, vec![good, bad_group]))
                .unwrap_err();
            assert_eq!(err.code, code, "value {bad:?}");
            // Non-canonical value smuggled inside a Term arg (recursive) — the
            // INNER code propagates. (The Term itself is a legal Value; it is
            // rejected as an attr VALUE type only after canon validation, so
            // build the violation directly on the node type position instead.)
            let nested = Value::Term(std::sync::Arc::new(crate::datalog::TermBlob {
                functor: "wrap".to_string(),
                args: vec![bad.clone()].into(),
            }));
            let bad_nested = FactGroup::Edge {
                fact: super::super::GroupFact {
                    predicate: base_id(&fs, "edge"),
                    tuple: vec![Value::Id(1), Value::Id(2), nested].into(),
                },
            };
            let err = fs.assert_batch(batch(&fs, vec![bad_nested])).unwrap_err();
            assert_eq!(err.code, code, "nested {bad:?}");
        }
        let s2 = fs.snapshot();
        assert_eq!(
            sha_before,
            fs.canonical_state_sha(&s2),
            "aborted batches must leave the store byte-identical"
        );
    }

    // ── E-CAT-001 through FactStore::declare ───────────────────────

    #[test]
    fn declare_conflicts_are_e_cat_001_identical_idempotent() {
        let mut fs = fixture_store();
        let decl = PredicateDecl {
            id: CatalogPredicateId(0),
            name: "reaches".to_string(),
            arity: 2,
            strategy: PhysStrategy::Nary,
            cardinality: Cardinality::MultiValued,
            temporal: TemporalScope::Timeless,
            semiring: crate::storage_v2::types::BOOLTAG_SEMIRING_ID,
            key_cols: Box::new([0]),
            reverse: None,
            author_priority: Box::new([]),
            stats: PredicateStats::default(),
        };
        let id = FactStore::declare(&mut fs, decl.clone()).expect("fresh declare");
        // Identical redeclare → idempotent, same id.
        assert_eq!(FactStore::declare(&mut fs, decl.clone()).unwrap(), id);
        // Conflicts on every axis → E-CAT-001 (the P1 per-axis battery is the
        // oracle; here the trait path is exercised on three representatives).
        for mutate in [
            |d: &mut PredicateDecl| d.arity = 3,
            |d: &mut PredicateDecl| d.strategy = PhysStrategy::Adjacency,
            |d: &mut PredicateDecl| d.reverse = Some(Box::new([1, 0])),
        ] {
            let mut conflicting = decl.clone();
            mutate(&mut conflicting);
            let err = FactStore::declare(&mut fs, conflicting).unwrap_err();
            assert_eq!(err.code, "E-CAT-001");
        }
    }

    // ── E-CAP-001 typed rejections (none panic, none silently no-op) ──

    #[test]
    fn supersede_is_e_cap_001_supersession() {
        let fs = fixture_store();
        let err = fs
            .supersede(
                SupersedeScope {
                    author: fs.intern_author("analyzer"),
                    perspective: PERSPECTIVE_MAIN,
                    predicate: None,
                    subject_set: SubjectSet::All,
                },
                1,
            )
            .unwrap_err();
        assert_eq!(err.code, "E-CAP-001");
        assert!(err.detail.contains("supersession"), "{}", err.detail);
    }

    #[test]
    fn resolve_functional_is_e_cap_001_functional_resolution() {
        let fs = fixture_store();
        let s = fs.snapshot();
        let err = fs
            .resolve_functional(&s, base_id(&fs, "type"), PERSPECTIVE_MAIN, 11)
            .unwrap_err();
        assert_eq!(err.code, "E-CAP-001");
        assert!(
            err.detail.contains("functional-resolution"),
            "{}",
            err.detail
        );
    }

    #[test]
    fn per_predicate_compact_is_e_cap_001() {
        let fs = fixture_store();
        let err = fs
            .compact(Some(base_id(&fs, "edge")), CompactionTier::Tiered)
            .unwrap_err();
        assert_eq!(err.code, "E-CAP-001");
        assert!(
            err.detail.contains("per-predicate-compaction"),
            "{}",
            err.detail
        );
        // Whole-store compaction (None) delegates and succeeds.
        fs.compact(None, CompactionTier::FullMerge)
            .expect("full compact");
    }

    #[test]
    fn assert_batch_non_main_perspective_is_e_cap_001_perspectives() {
        let fs = fixture_store();
        let other = fs.intern_perspective("other");
        let mut b = batch(&fs, vec![node_group(&fs, 100, "FUNCTION", &[])]);
        b.perspective = other;
        let err = fs.assert_batch(b).unwrap_err();
        assert_eq!(err.code, "E-CAP-001");
        assert!(err.detail.contains("perspectives"), "{}", err.detail);
    }

    #[test]
    fn lone_attr_on_existing_entity_is_e_cap_001_assertion_granularity() {
        let fs = fixture_store();
        // Node 11 exists (fixture); asserting just an attr for it is sub-record
        // granularity (§2.1) — loud rejection, not a fake partial write.
        let lone_attr = FactGroup::Node {
            facts: vec![super::super::GroupFact {
                predicate: base_id(&fs, "attr"),
                tuple: vec![
                    Value::Id(11),
                    Value::Str("line".to_string()),
                    Value::Str("6".to_string()),
                ]
                .into(),
            }],
        };
        let err = fs.assert_batch(batch(&fs, vec![lone_attr])).unwrap_err();
        assert_eq!(err.code, "E-CAP-001");
        assert!(
            err.detail.contains("assertion-granularity"),
            "{}",
            err.detail
        );
    }

    #[test]
    fn reverse_on_reverse_none_predicate_is_typed_e_cap_001_not_silent_empty() {
        let mut fs = fixture_store();
        let id = FactStore::declare(
            &mut fs,
            PredicateDecl {
                id: CatalogPredicateId(0),
                name: "noreverse".to_string(),
                arity: 2,
                strategy: PhysStrategy::Nary,
                cardinality: Cardinality::MultiValued,
                temporal: TemporalScope::Timeless,
                semiring: crate::storage_v2::types::BOOLTAG_SEMIRING_ID,
                key_cols: Box::new([0]),
                reverse: None,
                author_priority: Box::new([]),
                stats: PredicateStats::default(),
            },
        )
        .unwrap();
        let s = fs.snapshot();
        let err = fs
            .sorted_run(&s, id, PERSPECTIVE_MAIN, SortOrder::Reverse)
            .err()
            .expect("typed error, not an iterator");
        assert_eq!(err.code, "E-CAP-001");
        assert!(err.detail.contains("reverse-run"), "{}", err.detail);
        // Forward on the same predicate: an honest EMPTY relation (declared, no
        // facts in P2) — not an error.
        assert!(collect(fs.sorted_run(&s, id, PERSPECTIVE_MAIN, SortOrder::Forward)).is_empty());
    }

    #[test]
    fn unknown_predicate_id_is_e_cat_001() {
        let fs = fixture_store();
        let s = fs.snapshot();
        let err = fs
            .sorted_run(
                &s,
                CatalogPredicateId(999),
                PERSPECTIVE_MAIN,
                SortOrder::Forward,
            )
            .err()
            .expect("typed error");
        // P3 (round-007-pre C10): the unknown-ID read path migrated E-CAT-001 →
        // E-CAT-002 with round-009.
        assert_eq!(err.code, "E-CAT-002");
        // Unknown author on write stays E-CAT-001 (an interning error, not the
        // undeclared-predicate class).
        let foreign_author = AuthorId(999);
        let err = fs
            .assert_batch(AssertBatch {
                perspective: PERSPECTIVE_MAIN,
                author: foreign_author,
                tick: 1,
                groups: vec![],
            })
            .unwrap_err();
        assert_eq!(err.code, "E-CAT-001");
    }

    // ── FactRow synthesis (§10.1 conversion table) ─────────────────

    #[test]
    fn synthesis_source_generation_move_into_assertion_fields() {
        let fs = fixture_store();
        let s = fs.snapshot();
        let rows = collect(fs.sorted_run(
            &s,
            base_id(&fs, "node"),
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
        ));
        assert_eq!(rows.len(), 4);
        for row in &rows {
            assert_eq!(row.assertions.len(), 1, "exactly ONE synthesized assertion");
            let a = &row.assertions[0];
            assert_eq!(a.fid, row.fid);
            assert!(a.tag.is_bool(), "prod segments carry no tag columns → Bool");
            assert_eq!(a.tx_created, 0);
            assert_eq!(a.tx_invalidated, TX_OPEN);
        }
        let by_id = |id: u128| {
            rows.iter()
                .find(|r| r.key.tuple[0] == Value::Id(id))
                .expect("fixture node")
        };
        // _source → interned author; _generation → tick.
        let a11 = &by_id(11).assertions[0];
        assert_eq!(fs.author_name(a11.author).as_deref(), Some("analyzer"));
        assert_eq!(a11.tick, 3);
        // Missing both → ($legacy, 0).
        let a33 = &by_id(33).assertions[0];
        assert_eq!(fs.author_name(a33.author).as_deref(), Some(LEGACY_AUTHOR));
        assert_eq!(a33.tick, 0);
        // String-typed generation parses; missing source → $legacy.
        let a44 = &by_id(44).assertions[0];
        assert_eq!(fs.author_name(a44.author).as_deref(), Some(LEGACY_AUTHOR));
        assert_eq!(a44.tick, 9);
        // _source/_generation are NOT attr facts (they moved into the assertion).
        let attrs = collect(fs.prefix_scan(
            &s,
            base_id(&fs, "attr"),
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
            &[Value::Id(11)],
        ));
        for row in &attrs {
            let key = &row.key.tuple[1];
            assert_ne!(key, &Value::Str("_source".to_string()));
            assert_ne!(key, &Value::Str("_generation".to_string()));
        }
        // Non-reserved metadata keys ARE attrs, numbers/bools stringified,
        // column: 0 included (never `!value`-dropped), nested objects skipped.
        let attr_pairs: Vec<(String, String)> = attrs
            .iter()
            .map(|r| match (&r.key.tuple[1], &r.key.tuple[2]) {
                (Value::Str(k), Value::Str(v)) => (k.clone(), v.clone()),
                other => panic!("attr tuple must be (Id, Str, Str): {other:?}"),
            })
            .collect();
        let expect = |k: &str, v: &str| {
            assert!(
                attr_pairs.iter().any(|(kk, vv)| kk == k && vv == v),
                "missing attr {k}={v} in {attr_pairs:?}"
            );
        };
        expect("name", "fn1");
        expect("file", "a/f.js");
        expect("semantic_id", "a/f.js->FUNCTION->fn1");
        expect("line", "5");
        expect("async", "true");
        expect("column", "0");
        assert!(
            !attr_pairs.iter().any(|(k, _)| k == "nested"),
            "object-valued metadata is not a scalar attr"
        );
    }

    // ── sorted_run order + prefix_scan boundaries ──────────────────

    #[test]
    fn sorted_run_emits_canon_ascending_rows() {
        let fs = fixture_store();
        let s = fs.snapshot();
        for (pred, order) in [
            ("node", SortOrder::Forward),
            ("node", SortOrder::Reverse),
            ("type", SortOrder::Reverse),
            ("edge", SortOrder::Forward),
            ("edge", SortOrder::Reverse),
            ("incoming", SortOrder::Forward),
            ("attr", SortOrder::Forward),
            ("attr", SortOrder::Reverse),
        ] {
            let rows = collect(fs.sorted_run(&s, base_id(&fs, pred), PERSPECTIVE_MAIN, order));
            assert!(!rows.is_empty(), "{pred} fixture rows");
            let decl = fs.catalog().get(pred).unwrap();
            let cols = fs.order_cols(decl, order).unwrap();
            for pair in rows.windows(2) {
                let key = |r: &FactRow| -> Vec<Value> {
                    cols.iter().map(|&c| r.key.tuple[c].clone()).collect()
                };
                assert!(
                    key(&pair[0]) <= key(&pair[1]),
                    "{pred} {order:?} not ascending in canon order"
                );
            }
        }
    }

    #[test]
    fn prefix_scan_boundary_cases() {
        let fs = fixture_store();
        let s = fs.snapshot();
        let edge = base_id(&fs, "edge");
        // Empty prefix = the full run.
        let full = collect(fs.sorted_run(&s, edge, PERSPECTIVE_MAIN, SortOrder::Forward));
        let empty_prefix =
            collect(fs.prefix_scan(&s, edge, PERSPECTIVE_MAIN, SortOrder::Forward, &[]));
        assert_eq!(full, empty_prefix);
        assert_eq!(full.len(), 4);
        // Prefix past the end (unknown id) = empty.
        assert!(collect(fs.prefix_scan(
            &s,
            edge,
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
            &[Value::Id(u128::MAX)]
        ))
        .is_empty());
        // Mid-run exact window: src 11 has exactly two outgoing edges.
        let out11 = collect(fs.prefix_scan(
            &s,
            edge,
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
            &[Value::Id(11)],
        ));
        assert_eq!(out11.len(), 2);
        for row in &out11 {
            assert_eq!(row.key.tuple[0], Value::Id(11));
        }
        // Two-column prefix narrows to one row.
        let one = collect(fs.prefix_scan(
            &s,
            edge,
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
            &[Value::Id(11), Value::Id(22)],
        ));
        assert_eq!(one.len(), 1);
        // A prefix longer than the tuple = empty, not a panic.
        assert!(collect(fs.prefix_scan(
            &s,
            edge,
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
            &[
                Value::Id(11),
                Value::Id(22),
                Value::Str("CALLS".into()),
                Value::Id(9)
            ]
        ))
        .is_empty());
    }

    /// Round-008 R1 (the review's reproduction, pinned): re-asserting the SAME
    /// edge key with new provenance must yield ONE assertion per fid on EVERY
    /// read path — the full run and all four keyed paths agree on the newest
    /// record's author/tick (prefix_scan is a window of sorted_run at FactRow
    /// level, provenance included).
    #[test]
    fn edge_provenance_is_path_independent_after_reassert() {
        let fs = LsmFactStore::ephemeral(2);
        let edge_group = |author: &str, tick: u64| AssertBatch {
            perspective: PERSPECTIVE_MAIN,
            author: fs.intern_author(author),
            tick,
            groups: vec![FactGroup::Edge {
                fact: super::super::GroupFact {
                    predicate: base_id(&fs, "edge"),
                    tuple: vec![Value::Id(1), Value::Id(2), Value::Str("CALLS".into())].into(),
                },
            }],
        };
        // The legacy write path routes an edge to its SOURCE NODE's shard and
        // silently skips edges whose source node is unknown (upsert_edges) —
        // so the endpoints must exist first, as they always do in production.
        fs.assert_batch(AssertBatch {
            perspective: PERSPECTIVE_MAIN,
            author: fs.intern_author("writer-v1"),
            tick: 1,
            groups: vec![
                node_group(&fs, 1, "FUNCTION", &[]),
                node_group(&fs, 2, "FUNCTION", &[]),
            ],
        })
        .expect("endpoint nodes");
        fs.assert_batch(edge_group("writer-v1", 1))
            .expect("first assert");
        fs.assert_batch(edge_group("writer-v2", 9))
            .expect("re-assert");
        let s = fs.snapshot();
        let prov = |rows: Vec<FactRow>, label: &str| -> (u128, String, u64) {
            assert_eq!(rows.len(), 1, "{label}: exactly one deduped row");
            let a = &rows[0].assertions[0];
            (
                rows[0].fid,
                fs.author_name(a.author).expect("interned"),
                a.tick,
            )
        };
        let full = prov(
            collect(fs.sorted_run(
                &s,
                base_id(&fs, "edge"),
                PERSPECTIVE_MAIN,
                SortOrder::Forward,
            )),
            "sorted_run(edge)",
        );
        assert_eq!(
            (full.1.as_str(), full.2),
            ("writer-v2", 9),
            "the full run projects the newest record"
        );
        for (pred, order, key) in [
            ("edge", SortOrder::Forward, 1u128),
            ("edge", SortOrder::Reverse, 2),
            ("incoming", SortOrder::Forward, 2),
            ("incoming", SortOrder::Reverse, 1),
        ] {
            let keyed = prov(
                collect(fs.prefix_scan(
                    &s,
                    base_id(&fs, pred),
                    PERSPECTIVE_MAIN,
                    order,
                    &[Value::Id(key)],
                )),
                &format!("prefix_scan({pred}, {order:?})"),
            );
            assert_eq!(
                (keyed.1.as_str(), keyed.2),
                ("writer-v2", 9),
                "prefix_scan({pred}, {order:?}) must project the SAME winner"
            );
        }
        // `incoming` shares the fid of its own tuple, `edge` its own — but each
        // path of one predicate yields the SAME (fid, author, tick).
        let keyed_edge = prov(
            collect(fs.prefix_scan(
                &s,
                base_id(&fs, "edge"),
                PERSPECTIVE_MAIN,
                SortOrder::Forward,
                &[Value::Id(1)],
            )),
            "edge keyed",
        );
        assert_eq!(keyed_edge, full, "one fid, one Assertion, path-independent");
    }

    /// Round-008 R2: a legacy metadata blob carrying a key that collides with a
    /// privileged record column (`name`/`file`/`semantic_id`) must NOT mint a
    /// second attr fact — the column is authoritative (today's attr dispatch),
    /// equal-value collision would be the same fid twice (§2.2), and no fid may
    /// appear twice in one run.
    #[test]
    fn attr_blob_collision_with_column_is_single_fact() {
        let fs = LsmFactStore::ephemeral(2);
        // Equal-value collision: blob "name" == column name.
        let mut m1 = serde_json::Map::new();
        m1.insert("name".into(), "same".into());
        m1.insert("line".into(), 7u64.into());
        let n1 = node_rec(
            201,
            "FUNCTION",
            "same",
            "c/e.js",
            &serde_json::Value::Object(m1).to_string(),
        );
        // Differing-value collision: blob "name"/"file"/"semantic_id" all differ.
        let mut m2 = serde_json::Map::new();
        m2.insert("name".into(), "blobName".into());
        m2.insert("file".into(), "blob/file.js".into());
        m2.insert("semantic_id".into(), "blob->sid".into());
        let n2 = node_rec(
            202,
            "FUNCTION",
            "colName",
            "c/e.js",
            &serde_json::Value::Object(m2).to_string(),
        );
        fs.commit_legacy(vec![n1, n2], vec![], &[]);
        let s = fs.snapshot();
        for (id, want_name) in [(201u128, "same"), (202, "colName")] {
            let rows = collect(fs.prefix_scan(
                &s,
                base_id(&fs, "attr"),
                PERSPECTIVE_MAIN,
                SortOrder::Forward,
                &[Value::Id(id)],
            ));
            let names: Vec<&Value> = rows
                .iter()
                .filter(|r| r.key.tuple[1] == Value::Str("name".into()))
                .map(|r| &r.key.tuple[2])
                .collect();
            assert_eq!(
                names,
                vec![&Value::Str(want_name.to_string())],
                "exactly one name attr, the COLUMN value ({id})"
            );
            // No fid appears twice in the run (§2.2 no-duplicates).
            let mut fids: Vec<u128> = rows.iter().map(|r| r.fid).collect();
            fids.sort_unstable();
            fids.dedup();
            assert_eq!(fids.len(), rows.len(), "no duplicate fid in one run ({id})");
        }
        // The full attr run carries no duplicate fid either (stats/sha inputs).
        let all = collect(fs.sorted_run(
            &s,
            base_id(&fs, "attr"),
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
        ));
        let mut fids: Vec<u128> = all.iter().map(|r| r.fid).collect();
        fids.sort_unstable();
        fids.dedup();
        assert_eq!(fids.len(), all.len(), "full attr run: unique fids");
    }

    // ── get_fact / tuple / lazy index ──────────────────────────────

    #[test]
    fn get_fact_tuple_round_trip_and_lazy_index_builds_once() {
        let fs = fixture_store();
        let s = fs.snapshot();
        assert_eq!(
            fs.fid_index_builds(&s),
            0,
            "index not built before first use"
        );
        let mut seen = 0;
        for pred in ["node", "type", "edge", "incoming", "attr"] {
            for row in
                collect(fs.sorted_run(&s, base_id(&fs, pred), PERSPECTIVE_MAIN, SortOrder::Forward))
            {
                let fetched = fs
                    .get_fact(&s, row.fid)
                    .expect("every projected fid resolves");
                assert_eq!(fetched.key, row.key);
                assert_eq!(
                    fs.tuple(&s, row.fid).expect("tuple"),
                    row.key.tuple,
                    "fid → tuple round-trip"
                );
                seen += 1;
            }
        }
        assert!(seen > 0);
        // Absent fid → None (both primitives).
        assert!(fs.get_fact(&s, 0xdead_beef).is_none());
        assert!(fs.tuple(&s, 0xdead_beef).is_none());
        // Memoized: all of the above built the index exactly once (C14).
        assert_eq!(fs.fid_index_builds(&s), 1);
    }

    // ── live_filter (§2.4, degenerate-but-exact) ───────────────────

    #[test]
    fn live_filter_passes_all_p2_rows_and_drops_tx_invalidated() {
        let fs = fixture_store();
        let s = fs.snapshot();
        let rows = collect(fs.sorted_run(
            &s,
            base_id(&fs, "edge"),
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
        ));
        // Empty supersedes ⟹ identity over projected rows (count equality on
        // the full run).
        let filtered: Vec<FactRow> = fs
            .live_filter(&s, Box::new(rows.clone().into_iter()))
            .collect();
        assert_eq!(filtered, rows);
        // Cache rule 1: a hand-built row with tx_invalidated != TX_OPEN is DEAD.
        let mut dead = rows[0].clone();
        dead.assertions[0].tx_invalidated = 5;
        let survivors: Vec<FactRow> = fs
            .live_filter(&s, Box::new(vec![dead, rows[1].clone()].into_iter()))
            .collect();
        assert_eq!(survivors.len(), 1);
        assert_eq!(survivors[0], rows[1]);
    }

    // ── snapshot isolation ─────────────────────────────────────────

    #[test]
    fn writes_after_snapshot_are_invisible_to_it_visible_to_fresh_one() {
        let fs = fixture_store();
        let node = base_id(&fs, "node");
        let s1 = fs.snapshot();
        let before = collect(fs.sorted_run(&s1, node, PERSPECTIVE_MAIN, SortOrder::Forward)).len();
        fs.assert_batch(batch(
            &fs,
            vec![node_group(
                &fs,
                555,
                "FUNCTION",
                &[("name", Value::Str("late".into()))],
            )],
        ))
        .expect("write");
        // The pinned snapshot still answers the OLD state.
        assert_eq!(
            collect(fs.sorted_run(&s1, node, PERSPECTIVE_MAIN, SortOrder::Forward)).len(),
            before
        );
        // A fresh snapshot sees the write.
        let s2 = fs.snapshot();
        assert_eq!(
            collect(fs.sorted_run(&s2, node, PERSPECTIVE_MAIN, SortOrder::Forward)).len(),
            before + 1
        );
    }

    // ── perspective hygiene (§5.4a) ────────────────────────────────

    #[test]
    fn non_main_perspective_reads_empty_on_every_primitive() {
        let fs = fixture_store();
        let other = fs.intern_perspective("other");
        let s = fs.snapshot();
        for pred in ["node", "type", "edge", "incoming", "attr"] {
            let p = base_id(&fs, pred);
            assert!(
                collect(fs.sorted_run(&s, p, other, SortOrder::Forward)).is_empty(),
                "{pred}: a perspective with no facts answers nothing (exact match)"
            );
            assert!(
                collect(fs.prefix_scan(&s, p, other, SortOrder::Forward, &[Value::Id(11)]))
                    .is_empty()
            );
        }
        // get_fact keys on fid, which ENCODES the perspective name: a main fid
        // resolves, the same tuple hashed under "other" does not exist.
        let main_fid = super::super::fid(
            "main",
            "node",
            &[Value::Id(11), Value::Str("FUNCTION".into())],
        )
        .unwrap();
        let other_fid = super::super::fid(
            "other",
            "node",
            &[Value::Id(11), Value::Str("FUNCTION".into())],
        )
        .unwrap();
        assert!(fs.get_fact(&s, main_fid).is_some());
        assert!(fs.get_fact(&s, other_fid).is_none());
    }

    // ── stats (ledger C13) ─────────────────────────────────────────

    #[test]
    fn stats_populated_for_base_five_with_not_computed_sentinel() {
        let fs = fixture_store();
        for (pred, expected) in [("node", 4), ("type", 4), ("edge", 4), ("incoming", 4)] {
            let st = fs.stats(base_id(&fs, pred));
            assert_eq!(st.live_facts, expected, "{pred}");
            assert_eq!(st.live_asserts, expected, "{pred}: one assertion per row");
            assert_eq!(st.max_fanout, 0, "not computed until P3");
            assert_eq!(st.updated_at_tx, 0, "sentinel: not computed (P3 owns it)");
        }
        // attr count = the projected attr fact count of the fixture.
        let s = fs.snapshot();
        let attr_rows = collect(fs.sorted_run(
            &s,
            base_id(&fs, "attr"),
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
        ));
        assert_eq!(
            fs.stats(base_id(&fs, "attr")).live_facts,
            attr_rows.len() as u64
        );
    }

    // ── bulk load delegation ───────────────────────────────────────

    #[test]
    fn bulk_load_round_trip_delegates_and_data_survives() {
        let mut fs = fixture_store();
        fs.begin_bulk_load().expect("relax durability");
        fs.assert_batch(AssertBatch {
            perspective: PERSPECTIVE_MAIN,
            author: fs.intern_author("bulk"),
            tick: 1,
            groups: vec![node_group(&fs, 700, "FUNCTION", &[])],
        })
        .expect("bulk write");
        fs.end_bulk_load().expect("barrier");
        let s = fs.snapshot();
        let rows = collect(fs.prefix_scan(
            &s,
            base_id(&fs, "node"),
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
            &[Value::Id(700)],
        ));
        assert_eq!(rows.len(), 1);
    }

    // ── canonical_state_sha basics (the differential covers the rest) ──

    #[test]
    fn state_sha_changes_on_write_and_survives_compaction() {
        let fs = fixture_store();
        let s1 = fs.snapshot();
        let sha1 = fs.canonical_state_sha(&s1);
        // Same snapshot, second call: deterministic.
        assert_eq!(sha1, fs.canonical_state_sha(&s1));
        // Physics-invariance: compaction must not move the LOGICAL state hash
        // (the P2-testable half of C3).
        fs.compact(None, CompactionTier::FullMerge)
            .expect("compact");
        let s2 = fs.snapshot();
        assert_eq!(
            sha1,
            fs.canonical_state_sha(&s2),
            "compaction is physics, not truth"
        );
        // A write CHANGES it.
        fs.assert_batch(batch(&fs, vec![node_group(&fs, 600, "CLASS", &[])]))
            .expect("write");
        let s3 = fs.snapshot();
        assert_ne!(sha1, fs.canonical_state_sha(&s3));
    }

    #[test]
    fn state_sha_invariant_under_declaration_order_permutation() {
        // §9.2: canonical artifacts hash NAMES, not interned ids — declaring
        // extra predicates in different orders must not move the sha.
        let (nodes, edges) = fixture_records();
        let mut fs1 = LsmFactStore::ephemeral(2);
        fs1.commit_legacy(nodes.clone(), edges.clone(), &[]);
        let mut fs2 = LsmFactStore::ephemeral(2);
        fs2.commit_legacy(nodes, edges, &[]);
        for name in ["alpha", "beta"] {
            FactStore::declare(&mut fs1, nary_decl(name)).unwrap();
        }
        for name in ["beta", "alpha"] {
            FactStore::declare(&mut fs2, nary_decl(name)).unwrap();
        }
        let s1 = fs1.snapshot();
        let s2 = fs2.snapshot();
        assert_eq!(fs1.canonical_state_sha(&s1), fs2.canonical_state_sha(&s2));
    }

    fn nary_decl(name: &str) -> PredicateDecl {
        PredicateDecl {
            id: CatalogPredicateId(0),
            name: name.to_string(),
            arity: 2,
            strategy: PhysStrategy::Nary,
            cardinality: Cardinality::MultiValued,
            temporal: TemporalScope::Timeless,
            semiring: crate::storage_v2::types::BOOLTAG_SEMIRING_ID,
            key_cols: Box::new([0]),
            reverse: None,
            author_priority: Box::new([]),
            stats: PredicateStats::default(),
        }
    }
}
