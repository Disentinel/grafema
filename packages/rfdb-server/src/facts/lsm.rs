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
    PerspectiveId, PerspectiveTable, Snapshot, SortOrder, SubjectSet, SupersedeScope,
    PERSPECTIVE_MAIN, PERSPECTIVE_MAIN_NAME,
};
use crate::datalog::Value;
use crate::derive::canon::push_varint;
use crate::derive::catalog::{
    AuthorId, Cardinality, CatalogPredicateId, PredicateCatalog, PredicateDecl, PredicateStats,
};
use crate::derive::tag::{TagV2, TX_OPEN};
use crate::storage_v2::compaction::CompactionConfig;
use crate::storage_v2::manifest::{DurabilityMode, ManifestStore};
use crate::storage_v2::multi_shard::MultiShardStore;
use crate::storage_v2::read_snapshot::ReadSnapshot;
use crate::storage_v2::types::{DerivedFields, EdgeRecordV2, NodeRecordV2, ProvenanceV2};

/// The author name substituted for records with no `_source` (§10.1: 917 nodes /
/// 33 096 edges on the measured base; the projection must count them, not hide them).
pub const LEGACY_AUTHOR: &str = "$legacy";

/// Metadata keys that are ASSERTION fields, not attr facts (§6.2 «0 доп. фактов»).
const RESERVED_META_KEYS: [&str; 2] = ["_source", "_generation"];

/// The reserved node_type carrying `supersedes/2` facts inside today's closed
/// {nodes, edges} segment vocabulary (P4, ledger round-010-pre D1). Reserved
/// records are visible to the LEGACY node surfaces as ordinary rows (§9.4
/// `rows` semantics) but NEVER project as node/type/attr FACTS — they project
/// ONLY as supersedes facts. Writable exclusively through `supersede()` /
/// `FactGroup::Supersedes` (the E-SUP-001 boundary); a node GROUP naming this
/// type is rejected.
pub const SUPERSEDES_NODE_TYPE: &str = "$supersedes";

/// The reserved virtual file of supersedes records: routes them all to one
/// shard and can never intersect a reanalysis `changed_files` set (D1).
pub const SUPERSEDES_FILE: &str = "$rofl/supersedes";

/// Metadata keys carrying the supersedes tuple on a reserved record (32-hex).
const SUPERSEDES_META_NEW: &str = "aid_new";
const SUPERSEDES_META_OLD: &str = "aid_old";

/// The R-1a seeded `author_priority` pair (OWNER-RULINGS R-1a, ledger
/// round-011-pre E3): exactly ONE pair on the `node`/`type` decls —
/// haskell-runtime-globals > haskell-local-refs. Grounds: the 39 measured
/// conflicts are prelude names whose canonical home is
/// runtime-globals/GLOBAL_DEFINITION (W23/Q2); EXTERNAL_FUNCTION from
/// haskell-local-refs is the retired representation, and the pair restores
/// zero behavior flip vs today's storage winner on all 39.
pub const SEEDED_PRIORITY_HIGH: &str = "haskell-runtime-globals";
/// The lower-priority member of the R-1a seeded pair.
pub const SEEDED_PRIORITY_LOW: &str = "haskell-local-refs";

/// The audit perspective carrying `conflict/5` emissions (§2.3; interned at
/// construction, round-011-pre E4).
pub const PERSPECTIVE_AUDIT_NAME: &str = "audit";

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
    /// Does any segment in this snapshot carry derived (v3) columns? Dispatches
    /// between the P2 winner-collapse fast paths (pure-v2 store — the real
    /// base) and the version-granular grouped projection (ledger D8). Memoized
    /// per snapshot; the answer is snapshot-pinned.
    derived_present: OnceLock<bool>,
    /// The §2.4 killed-aid set of this snapshot (victims of LIVE supersedes
    /// assertions, computed by the well-founded decreasing-tick pass — D14).
    /// Memoized: liveness is asked per read, the set is snapshot-constant.
    superseded: OnceLock<HashSet<u128>>,
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
    /// The audit perspective (P5, E4): `conflict/5` FactKeys are emitted here.
    audit_persp: PerspectiveId,
}

#[derive(Debug, Clone, Copy)]
struct BaseIds {
    node: CatalogPredicateId,
    ty: CatalogPredicateId,
    edge: CatalogPredicateId,
    incoming: CatalogPredicateId,
    attr: CatalogPredicateId,
    /// The reserved supersedes/2 predicate (P4, D13 — declared at construction).
    supersedes: CatalogPredicateId,
    /// The reserved conflict/5 predicate (P5, E4 — declared at construction).
    conflict: CatalogPredicateId,
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
        let mut catalog = PredicateCatalog::with_base_relations();
        // P4 (D13): the facts backend owns the reserved supersedes/2 predicate.
        // Declared here — NOT in with_base_relations — so the planner's base
        // id-space and dispatch stay golden-pinned.
        catalog
            .declare(PredicateCatalog::supersedes_decl())
            .expect("fresh catalog accepts supersedes");
        // P5 (round-011-pre E3/E4, same ownership precedent): the facts
        // backend interns the R-1a seeded pair into ITS author table (AuthorId
        // is store-interner-local — with_base_relations has no author table
        // and stays plan-golden-pinned), amends the base node/type decls to
        // Functional with that pair, and declares the reserved conflict/5
        // predicate plus the audit perspective.
        let mut authors = AuthorTable::default();
        let seeded_pair: Box<[AuthorId]> = Box::new([
            authors.intern(SEEDED_PRIORITY_HIGH),
            authors.intern(SEEDED_PRIORITY_LOW),
        ]);
        catalog
            .amend_functional("node", seeded_pair.clone())
            .expect("base node decl is amendable");
        catalog
            .amend_functional("type", seeded_pair)
            .expect("base type decl is amendable");
        catalog
            .declare(PredicateCatalog::conflict_decl())
            .expect("fresh catalog accepts conflict");
        let mut perspectives = PerspectiveTable::new();
        let audit_persp = perspectives.intern(PERSPECTIVE_AUDIT_NAME);
        let base = BaseIds {
            node: catalog.get("node").expect("base").id,
            ty: catalog.get("type").expect("base").id,
            edge: catalog.get("edge").expect("base").id,
            incoming: catalog.get("incoming").expect("base").id,
            attr: catalog.get("attr").expect("base").id,
            supersedes: catalog.get("supersedes").expect("declared above").id,
            conflict: catalog.get("conflict").expect("declared above").id,
        };
        Self {
            store: RwLock::new(store),
            manifest: Mutex::new(manifest),
            catalog,
            perspectives: RwLock::new(perspectives),
            authors: RwLock::new(authors),
            stats: OnceLock::new(),
            zero_stats: PredicateStats::default(),
            base,
            audit_persp,
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

    /// Test seam: commit records through the DERIVED facts path with caller-
    /// chosen DerivedFields (the C3 gate needs Count-tagged assertions, which
    /// `assert_batch`'s Bool default cannot mint until tags enter the §7.2
    /// write surface in a later phase).
    #[cfg(test)]
    pub(crate) fn commit_derived_tagged(
        &self,
        nodes: Vec<(NodeRecordV2, DerivedFields)>,
        edges: Vec<(EdgeRecordV2, DerivedFields)>,
    ) -> u64 {
        let mut store = self.store.write().unwrap();
        let mut manifest = self.manifest.lock().unwrap();
        store
            .commit_batch_derived(nodes, edges, &mut manifest)
            .expect("derived commit")
    }

    /// Crate seam: the pinned MVCC read snapshot inside `s` (for building the
    /// StorageView oracle on the IDENTICAL snapshot). Also the P6 converter's
    /// record-enumeration pin (round-012-pre S1): the §6.2 decomposition needs
    /// whole RECORDS (metadata blob included), which the base-five fact
    /// projection cannot serve losslessly.
    pub(crate) fn read_snapshot_of(&self, s: &Snapshot) -> ReadSnapshot {
        self.payload(s)
            .expect("snapshot of this store")
            .snap
            .clone()
    }

    /// Crate seam: read access to the underlying store (oracle construction;
    /// P6 converter record enumeration — see [`Self::read_snapshot_of`]).
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

    /// Base + supersedes live counts (P4: LIVE per §2.4 — dead assertions and
    /// facts they emptied are excluded; on a supersedes-free snapshot this is
    /// numerically identical to the P2 projection counts).
    fn compute_base_stats(&self) -> HashMap<CatalogPredicateId, PredicateStats> {
        let store = self.store.read().unwrap();
        let snap = {
            let manifest = self.manifest.lock().unwrap();
            store.snapshot(&manifest)
        };
        let derived = self.derived_in(&store, &snap);
        let killed = self.compute_superseded(&store, &snap);
        let mut stats = HashMap::new();
        for id in [
            self.base.node,
            self.base.ty,
            self.base.edge,
            self.base.incoming,
            self.base.attr,
            self.base.supersedes,
        ] {
            let decl = self.catalog.get_by_id(id).expect("declared");
            let mut rows = self.project_predicate(&store, &snap, decl, derived);
            let mut facts = 0u64;
            let mut asserts = 0u64;
            for row in &mut rows {
                self.retain_live(&mut row.assertions, &killed);
                if !row.assertions.is_empty() {
                    facts += 1;
                    asserts += row.assertions.len() as u64;
                }
            }
            stats.insert(
                id,
                PredicateStats {
                    live_facts: facts,
                    live_asserts: asserts,
                    distinct: Box::new([]),
                    max_fanout: 0,
                    updated_at_tx: 0,
                },
            );
        }
        stats
    }

    /// FactRow synthesis, derived-column-aware (P4, ledger D5/D8): author/tick
    /// ALWAYS come from `_source`/`_generation` (§10.1 carriers); tag/tx come
    /// from the segment's derived columns when present (v3 records) and fall
    /// back to the Q2 synthesis (Bool, 0, TX_OPEN) for v2 records.
    fn synth_row_with(
        &self,
        pred_name: &str,
        tuple: Vec<Value>,
        metadata: &str,
        fields: Option<&DerivedFields>,
    ) -> FactRow {
        let (source, generation) = provenance(metadata);
        let author = self
            .authors
            .write()
            .unwrap()
            .intern(source.as_deref().unwrap_or(LEGACY_AUTHOR));
        let tuple: Box<[Value]> = tuple.into();
        let row_fid = fid(PERSPECTIVE_MAIN_NAME, pred_name, &tuple)
            .expect("projected tuples are Id/Str and always canonical");
        let (tag, tx_created, tx_invalidated) = match fields {
            Some(f) => (f.tag.clone(), f.tx_created, f.tx_invalidated),
            None => (TagV2::bool_one(), 0, TX_OPEN),
        };
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
                tag,
                tx_created,
                tx_invalidated,
            }],
        }
    }

    fn synth_row(&self, pred_name: &str, tuple: Vec<Value>, metadata: &str) -> FactRow {
        self.synth_row_with(pred_name, tuple, metadata, None)
    }

    fn node_row(&self, pred_name: &str, rec: &NodeRecordV2) -> FactRow {
        self.node_row_with(pred_name, rec, None)
    }

    fn node_row_with(
        &self,
        pred_name: &str,
        rec: &NodeRecordV2,
        fields: Option<&DerivedFields>,
    ) -> FactRow {
        self.synth_row_with(
            pred_name,
            vec![Value::Id(rec.id), Value::Str(rec.node_type.clone())],
            &rec.metadata,
            fields,
        )
    }

    fn edge_row(&self, pred_name: &str, rec: &EdgeRecordV2) -> FactRow {
        self.edge_row_with(pred_name, rec, None)
    }

    fn edge_row_with(
        &self,
        pred_name: &str,
        rec: &EdgeRecordV2,
        fields: Option<&DerivedFields>,
    ) -> FactRow {
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
        self.synth_row_with(pred_name, tuple, &rec.metadata, fields)
    }

    /// Decode a reserved supersedes record (D1) into its `supersedes/2` row.
    /// A malformed reserved record is CORRUPTION of the truth source — the
    /// projection aborts loudly (contractual panic, same class as the D3
    /// divergence arm) instead of silently dropping a supersession.
    fn supersedes_row(&self, rec: &NodeRecordV2, fields: Option<&DerivedFields>) -> FactRow {
        let parsed: serde_json::Value = serde_json::from_str(&rec.metadata).unwrap_or_else(|e| {
            panic!("E-SUP-001: corrupt reserved supersedes record {:x}: {e}", rec.id)
        });
        let read_aid = |key: &str| -> u128 {
            parsed
                .get(key)
                .and_then(|v| v.as_str())
                .and_then(|s| u128::from_str_radix(s, 16).ok())
                .unwrap_or_else(|| {
                    panic!(
                        "E-SUP-001: reserved supersedes record {:x} lacks a valid '{key}'",
                        rec.id
                    )
                })
        };
        let aid_new = read_aid(SUPERSEDES_META_NEW);
        let aid_old = read_aid(SUPERSEDES_META_OLD);
        let row = self.synth_row_with(
            "supersedes",
            vec![Value::Id(aid_new), Value::Id(aid_old)],
            &rec.metadata,
            fields,
        );
        // Record identity ≡ fact identity (D1): a mismatch is corruption.
        assert_eq!(
            row.fid, rec.id,
            "E-SUP-001: reserved supersedes record id does not match its tuple fid"
        );
        row
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
        self.attr_rows_for_with(rec, None)
    }

    fn attr_rows_for_with(
        &self,
        rec: &NodeRecordV2,
        fields: Option<&DerivedFields>,
    ) -> Vec<FactRow> {
        let mut rows = Vec::new();
        let mut push = |key: &str, value: String| {
            rows.push(self.synth_row_with(
                "attr",
                vec![
                    Value::Id(rec.id),
                    Value::Str(key.to_string()),
                    Value::Str(value),
                ],
                &rec.metadata,
                fields,
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
            .filter(|rec| rec.node_type != SUPERSEDES_NODE_TYPE)
            .flat_map(|rec| self.attr_rows_for(rec))
            .collect()
    }

    /// Does any segment of `snap` carry derived (v3) columns? Dispatches the
    /// projection between the P2 winner-collapse paths (pure v2 — the measured
    /// real base is 359/359 v2) and the version-granular grouped paths (D8).
    fn derived_in(&self, store: &MultiShardStore, snap: &ReadSnapshot) -> bool {
        store.any_derived_segments_at(snap)
    }

    fn derived_present(&self, payload: &LsmSnapshotPayload) -> bool {
        *payload.derived_present.get_or_init(|| {
            let store = self.store.read().unwrap();
            self.derived_in(&store, &payload.snap)
        })
    }

    /// One live node-record candidate per assertion (D8): every record version
    /// of an id, newest-first, deduped to
    /// - at most ONE v2 candidate per id (the winner — the record model), and
    /// - one v3 candidate per distinct aid identity (value, author, tick) —
    ///   the VALUE column is part of the key since P5 (round-011-pre E8a):
    ///   the aid is (fid, author, tick) and the fid contains the value, so
    ///   two same-(author, tick) records with different node_type are two
    ///   DISTINCT assertions, both projected.
    fn node_candidates(
        &self,
        store: &MultiShardStore,
        snap: &ReadSnapshot,
    ) -> Vec<(NodeRecordV2, Option<DerivedFields>)> {
        let versions = store
            .iter_node_versions_at(snap)
            .expect("readable node segments");
        #[allow(clippy::type_complexity)]
        let mut seen: HashMap<u128, (bool, HashSet<(String, Option<String>, u64)>)> =
            HashMap::new();
        let mut out = Vec::new();
        for (rec, fields) in versions {
            let entry = seen.entry(rec.id).or_default();
            let (source, generation) = provenance(&rec.metadata);
            let key = (rec.node_type.clone(), source, generation.unwrap_or(0));
            match &fields {
                None => {
                    // v2 record: winner-collapse — only the NEWEST v2 version
                    // of an id is a candidate (C22/R1 stays for the record
                    // model; sha-invariance across the base newest-wins merge).
                    if entry.0 {
                        continue;
                    }
                    entry.0 = true;
                    if !entry.1.insert(key) {
                        continue; // same aid already served by a newer v3 record
                    }
                    out.push((rec, None));
                }
                Some(_) => {
                    if !entry.1.insert(key) {
                        continue; // same-(author, tick) re-assert: newest wins (M1 is P7)
                    }
                    out.push((rec, fields));
                }
            }
        }
        out
    }

    /// Edge companion of [`Self::node_candidates`], keyed `(src, dst, type)`.
    fn edge_candidates(
        &self,
        store: &MultiShardStore,
        snap: &ReadSnapshot,
    ) -> Vec<(EdgeRecordV2, Option<DerivedFields>)> {
        let versions = store
            .iter_edge_versions_at(snap)
            .expect("readable edge segments");
        let mut seen: HashMap<(u128, u128, String), (bool, HashSet<(Option<String>, u64)>)> =
            HashMap::new();
        let mut out = Vec::new();
        for (rec, fields) in versions {
            let entry = seen
                .entry((rec.src, rec.dst, rec.edge_type.clone()))
                .or_default();
            let (source, generation) = provenance(&rec.metadata);
            let key = (source, generation.unwrap_or(0));
            match &fields {
                None => {
                    if entry.0 {
                        continue;
                    }
                    entry.0 = true;
                    if !entry.1.insert(key) {
                        continue;
                    }
                    out.push((rec, None));
                }
                Some(_) => {
                    if !entry.1.insert(key) {
                        continue;
                    }
                    out.push((rec, fields));
                }
            }
        }
        out
    }

    /// Merge candidate-major rows into fid-major [`FactRow`]s: one row per fid
    /// carrying ALL its assertions (§2.2 — the multi-assertion read shape),
    /// assertions sorted by (author name, tick) for deterministic reads.
    fn group_rows(&self, rows: Vec<FactRow>) -> Vec<FactRow> {
        let mut index: HashMap<u128, usize> = HashMap::new();
        let mut out: Vec<FactRow> = Vec::new();
        for row in rows {
            match index.get(&row.fid) {
                Some(&i) => out[i].assertions.extend(row.assertions),
                None => {
                    index.insert(row.fid, out.len());
                    out.push(row);
                }
            }
        }
        let authors = self.authors.read().unwrap();
        for row in &mut out {
            row.assertions.sort_by(|a, b| {
                let na = authors.name(a.author).expect("interned during projection");
                let nb = authors.name(b.author).expect("interned during projection");
                na.cmp(nb).then(a.tick.cmp(&b.tick))
            });
        }
        out
    }

    /// All main-perspective rows of `decl` in this snapshot. `derived` selects
    /// the projection regime (D8): the P2 winner paths on a pure-v2 snapshot
    /// (byte-identical to P2 — the equivalence pairs pin it), the
    /// version-granular grouped paths when any v3 segment is visible.
    /// Any other DECLARED predicate is an honest empty relation, not an error.
    fn project_predicate(
        &self,
        store: &MultiShardStore,
        snap: &ReadSnapshot,
        decl: &PredicateDecl,
        derived: bool,
    ) -> Vec<FactRow> {
        match decl.name.as_str() {
            "node" | "type" => {
                if derived {
                    let rows: Vec<FactRow> = self
                        .node_candidates(store, snap)
                        .iter()
                        .filter(|(rec, _)| rec.node_type != SUPERSEDES_NODE_TYPE)
                        .map(|(rec, fields)| self.node_row_with(&decl.name, rec, fields.as_ref()))
                        .collect();
                    self.group_rows(rows)
                } else {
                    store
                        .find_nodes_at(snap, None, None)
                        .iter()
                        .filter(|rec| rec.node_type != SUPERSEDES_NODE_TYPE)
                        .map(|rec| self.node_row(&decl.name, rec))
                        .collect()
                }
            }
            "edge" | "incoming" => {
                if derived {
                    let rows: Vec<FactRow> = self
                        .edge_candidates(store, snap)
                        .iter()
                        .map(|(rec, fields)| self.edge_row_with(&decl.name, rec, fields.as_ref()))
                        .collect();
                    self.group_rows(rows)
                } else {
                    store
                        .iter_all_edges_at(snap)
                        .iter()
                        .map(|rec| self.edge_row(&decl.name, rec))
                        .collect()
                }
            }
            "attr" => {
                if derived {
                    let rows: Vec<FactRow> = self
                        .node_candidates(store, snap)
                        .iter()
                        .filter(|(rec, _)| rec.node_type != SUPERSEDES_NODE_TYPE)
                        .flat_map(|(rec, fields)| self.attr_rows_for_with(rec, fields.as_ref()))
                        .collect();
                    self.group_rows(rows)
                } else {
                    self.project_attr(store, snap)
                }
            }
            "supersedes" => {
                if derived {
                    let rows: Vec<FactRow> = self
                        .node_candidates(store, snap)
                        .iter()
                        .filter(|(rec, _)| rec.node_type == SUPERSEDES_NODE_TYPE)
                        .map(|(rec, fields)| self.supersedes_row(rec, fields.as_ref()))
                        .collect();
                    self.group_rows(rows)
                } else {
                    // Reserved records are only ever written through the v3
                    // path; a pure-v2 snapshot still runs the REAL scan (type
                    // zone-maps prune it to ~0 on the measured base — §2.4's
                    // "cold cost is zero").
                    store
                        .find_nodes_at(snap, Some(SUPERSEDES_NODE_TYPE), None)
                        .iter()
                        .map(|rec| self.supersedes_row(rec, None))
                        .collect()
                }
            }
            _ => Vec::new(),
        }
    }

    /// A read-lock-free snapshot of the author interner (index = AuthorId.0).
    fn author_names_snapshot(&self) -> Vec<String> {
        let authors = self.authors.read().unwrap();
        (0..u32::MAX)
            .map_while(|i| authors.name(AuthorId(i)).map(str::to_string))
            .collect()
    }

    /// The §2.4 killed-aid set of `snap` (D14): victims of LIVE supersedes
    /// assertions. Liveness of the supersedes assertions themselves is the
    /// SAME definitional rule, resolved by one pass in decreasing (tick, aid)
    /// order — well-founded because a superseder's tick strictly exceeds its
    /// victim's (E-SUP-001). The D3 divergence arm fires here for supersedes
    /// assertions; base-relation assertions are checked at their own read
    /// sites (live_filter / canonical_state_sha / stats).
    fn compute_superseded(&self, store: &MultiShardStore, snap: &ReadSnapshot) -> HashSet<u128> {
        let decl = self
            .catalog
            .get_by_id(self.base.supersedes)
            .expect("supersedes declared at construction");
        let derived = self.derived_in(store, snap);
        let rows = self.project_predicate(store, snap, decl, derived);
        if rows.is_empty() {
            return HashSet::new();
        }
        let names = self.author_names_snapshot();
        // (tick, own aid, victim aid, tx_invalidated) per supersedes assertion.
        let mut sups: Vec<(u64, u128, u128, u64)> = Vec::new();
        for row in &rows {
            let Some(Value::Id(victim)) = row.key.tuple.get(1) else {
                panic!("E-SUP-001: supersedes tuple without an Id victim");
            };
            for a in &row.assertions {
                let name = names
                    .get(a.author.0 as usize)
                    .expect("interned during projection");
                sups.push((a.tick, aid(row.fid, name, a.tick), *victim, a.tx_invalidated));
            }
        }
        // Decreasing tick; ties broken by aid for determinism (a tie can never
        // be a mutual kill — the boundary enforces strict tick monotonicity).
        // This sort IS the order contract of `resolve_supersession`: a killer's
        // tick strictly exceeds its victim's (E-SUP-001), so it is seen first.
        sups.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let pairs: Vec<(u128, u128)> =
            sups.iter().map(|(_, own, victim, _)| (*own, *victim)).collect();
        let (killed, live) = crate::facts::resolve_supersession(&pairs);
        // Rule 1 (D3 divergence arm): the tx_invalidated cache may only CONFIRM
        // death. A supersedes assertion cache-marked dead that the LAW calls
        // live is corruption, not a tie to break.
        for ((_, own, _, tx_invalidated), alive) in sups.iter().zip(live) {
            if *tx_invalidated != TX_OPEN && alive {
                panic!(
                    "E-SUP-001: divergence — supersedes assertion {own:x} is cache-marked dead \
                     with no live supersedes(_, aid) fact in this snapshot"
                );
            }
        }
        killed
    }

    /// Memoized killed-aid set of a snapshot payload.
    fn superseded_set<'a>(&self, payload: &'a LsmSnapshotPayload) -> &'a HashSet<u128> {
        payload.superseded.get_or_init(|| {
            let store = self.store.read().unwrap();
            self.compute_superseded(&store, &payload.snap)
        })
    }

    /// The §2.4 per-assertion liveness rule shared by every liveness authority
    /// (live_filter / canonical_state_sha / stats): dead ⟺ aid ∈ killed;
    /// rule 1 + the D3 divergence arm: a cache-dead assertion NOT in the
    /// killed set is corruption and aborts. Locks the author interner itself —
    /// projection may intern new authors at read time, so a caller-captured
    /// name snapshot could be stale.
    fn retain_live(&self, assertions: &mut smallvec::SmallVec<[Assertion; 2]>, killed: &HashSet<u128>) {
        let authors = self.authors.read().unwrap();
        assertions.retain(|a| {
            let name = authors
                .name(a.author)
                .expect("interned during projection");
            let dead = killed.contains(&aid(a.fid, name, a.tick));
            if a.tx_invalidated != TX_OPEN && !dead {
                panic!(
                    "E-SUP-001: divergence — assertion of fid {:x} (author '{name}', tick {}) is \
                     cache-marked dead with no live supersedes(_, aid) fact in this snapshot",
                    a.fid, a.tick
                );
            }
            !dead
        });
    }

    fn fid_index<'a>(&self, payload: &'a LsmSnapshotPayload) -> &'a HashMap<u128, FactRow> {
        payload.fid_index.get_or_init(|| {
            payload.index_builds.fetch_add(1, Ordering::SeqCst);
            let derived = self.derived_present(payload);
            let store = self.store.read().unwrap();
            let mut index = HashMap::new();
            for decl in self.catalog.iter() {
                for row in self.project_predicate(&store, &payload.snap, decl, derived) {
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
            derived_present: OnceLock::new(),
            superseded: OnceLock::new(),
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
        // P4 dispatch (D8): once ANY v3 segment is visible, keyed reads must
        // surface every coexisting assertion — the winner-collapsing targeted
        // delegations below are only correct for a pure-v2 snapshot (they stay
        // byte-identical to P2 there, which is what the equivalence pairs and
        // the real-base differential pin). Computed before taking the store
        // lock (it briefly takes its own read lock).
        let derived = self.derived_present(payload);
        let store = self.store.read().unwrap();
        let snap = &payload.snap;
        // Targeted delegations for bound leading keys (same *_at surface the
        // executor's view uses); everything else materializes the projection.
        let mut rows: Vec<FactRow> = if derived {
            self.project_predicate(&store, snap, decl, true)
        } else {
            match (decl.name.as_str(), o, prefix.first()) {
            ("node" | "type", SortOrder::Forward, Some(Value::Id(id))) => store
                .get_node_at(snap, *id)
                .filter(|rec| rec.node_type != SUPERSEDES_NODE_TYPE)
                .map(|rec| vec![self.node_row(&decl.name, &rec)])
                .unwrap_or_default(),
            ("type", SortOrder::Reverse, Some(Value::Str(ty))) if ty == SUPERSEDES_NODE_TYPE => {
                // Reserved records never project as type facts (D1).
                Vec::new()
            }
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
                .filter(|rec| rec.node_type != SUPERSEDES_NODE_TYPE)
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
            _ => self.project_predicate(&store, snap, decl, false),
            }
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
        // The REAL §2.4 anti-join (D14): assertion live ⟺ its aid is not a
        // victim of a LIVE supersedes assertion (recursive rule, well-founded
        // by tick); fact live ⟺ ≥1 live assertion. Rule 1: the tx_invalidated
        // cache may only CONFIRM death — a cache-dead assertion NOT in the
        // killed set is corruption and aborts E-SUP-001 (D3, contractual
        // panic; a typed error cannot surface mid-iterator without a
        // signature change the doc does not ask for).
        let killed: &HashSet<u128> = match self.payload(s) {
            Ok(payload) => self.superseded_set(payload),
            Err(_) => {
                // Foreign snapshot: no killed set exists; an EMPTY set keeps
                // the P2 behavior for hand-built rows (all-open pass through).
                static EMPTY: OnceLock<HashSet<u128>> = OnceLock::new();
                EMPTY.get_or_init(HashSet::new)
            }
        };
        Box::new(rows.filter_map(move |mut row| {
            self.retain_live(&mut row.assertions, killed);
            if row.assertions.is_empty() {
                None
            } else {
                Some(row)
            }
        }))
    }

    /// Functional-conflict resolution (§2.3, REAL since P5 — OWNER-RULINGS
    /// R-1a order, ledger round-011-pre E1/E5): candidates are ALL LIVE
    /// assertions of ALL facts of `p` whose c0 == `subject`, enumerated
    /// through the pre-dedup multi-candidate point read; the winner is picked
    /// by max tick → author_priority table → author canon-order → min fid
    /// (total — always decides, never errors); one conflict/5 FactKey per
    /// loser fact is RETURNED (never written — the store stays monotone).
    fn resolve_functional(
        &self,
        s: &Snapshot,
        p: CatalogPredicateId,
        persp: PerspectiveId,
        subject: u128,
    ) -> FactResult<Option<(FactRow, Vec<FactKey>)>> {
        self.resolve_functional_with(s, p, persp, subject, None)
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
        // batch pre-commit with the store unchanged. E-SUP-001 (D11/D12) is
        // part of the same pre-commit boundary for Supersedes groups.
        let mut nodes: Vec<NodeRecordV2> = Vec::new();
        let mut edges: Vec<EdgeRecordV2> = Vec::new();
        // Lazily-built aid → tick map of the pre-commit snapshot (only when a
        // Supersedes group is present — the boundary must resolve victims).
        let mut ticks: Option<HashMap<u128, (u64, AuthorId)>> = None;
        // E-FUNC-001 gate (§2.3 exact firing set, round-011-pre E6): ONE
        // author asserting TWO DISTINCT values of the Functional node/type
        // predicates about ONE subject within ONE batch is a producer bug —
        // pre-commit whole-batch abort (E-MAT-002/E-EXEC-001 class).
        // Identical-tuple re-assert (same fid) is idempotent, NOT a firing;
        // the same shape across DIFFERENT batches is legal (read-time
        // resolution). subject → asserted node_type of this batch:
        let mut functional_values: HashMap<u128, String> = HashMap::new();
        for group in &b.groups {
            match group {
                FactGroup::Node { facts } => {
                    let rec = self.build_node_record(facts, &author_name, b.tick)?;
                    match functional_values.get(&rec.id) {
                        Some(prev) if prev != &rec.node_type => {
                            return Err(FactStoreError {
                                code: "E-FUNC-001",
                                detail: format!(
                                    "intra-batch double assertion of the Functional node/type \
                                     value for subject {:x}: '{prev}' vs '{}' by one author \
                                     ('{author_name}') in one batch (§2.3 — producer bug; the \
                                     WHOLE batch is aborted pre-commit, store unchanged)",
                                    rec.id, rec.node_type
                                ),
                            })
                        }
                        Some(_) => {}
                        None => {
                            functional_values.insert(rec.id, rec.node_type.clone());
                        }
                    }
                    nodes.push(rec)
                }
                FactGroup::Edge { fact } => {
                    edges.push(self.build_edge_record(fact, &author_name, b.tick)?)
                }
                FactGroup::Supersedes { fact } => {
                    let ticks =
                        ticks.get_or_insert_with(|| self.assertion_ticks_snapshot());
                    nodes.push(self.build_supersedes_record(
                        fact,
                        b.author,
                        &author_name,
                        b.tick,
                        ticks,
                    )?)
                }
            }
        }
        if nodes.is_empty() && edges.is_empty() {
            // Nothing to publish; the current version is the token.
            let version = self.manifest.lock().unwrap().current().version;
            return Ok(CommitToken { version });
        }
        self.commit_derived(nodes, edges, b.tick)
    }

    /// §5.5, REAL since P4 (contract (1)): enumerate the LIVE assertions whose
    /// author == scope.author within the scope, write one supersedes fact per
    /// victim through the facts commit path. Author scoping is absolute
    /// (§4.2/D2); E-SUP-001 tick monotonicity aborts the WHOLE operation
    /// pre-commit (D11).
    fn supersede(&self, scope: SupersedeScope, at_tick: u64) -> FactResult<CommitToken> {
        if scope.perspective != PERSPECTIVE_MAIN {
            return Err(FactStoreError::cap(
                "perspectives",
                "today's record format cannot represent a non-main perspective (§10.1)",
            ));
        }
        let author_name = self.author_name(scope.author).ok_or(FactStoreError {
            code: "E-CAT-001",
            detail: format!(
                "unknown author id {:?} (intern via intern_author first)",
                scope.author
            ),
        })?;
        if let Some(p) = scope.predicate {
            // A scope over an undeclared predicate is the §3.4 unknown-id class.
            self.read_decl(p)?;
        }

        // Snapshot-pinned enumeration of the author's LIVE assertions in scope.
        let (store, snap) = {
            let store = self.store.read().unwrap();
            let snap = {
                let manifest = self.manifest.lock().unwrap();
                store.snapshot(&manifest)
            };
            (store, snap)
        };
        let derived = self.derived_in(&store, &snap);
        let killed = self.compute_superseded(&store, &snap);

        // D10: resolve the ByAttr subject set from the live attr relation.
        let by_attr_subjects: Option<HashSet<u128>> = match &scope.subject_set {
            SubjectSet::ByAttr { pred, values } => {
                if *pred != self.base.attr {
                    return Err(FactStoreError::cap(
                        "per-attribute-predicates",
                        "P4's base-five vocabulary has no per-attribute predicates (P6); \
                         encode §5.5 ByAttr as {pred: attr, values: [Str(key), matched values…]}",
                    ));
                }
                let Some(Value::Str(key)) = values.first() else {
                    return Err(FactStoreError::cap(
                        "per-attribute-predicates",
                        "ByAttr values must start with Str(attribute key) (ledger D10)",
                    ));
                };
                let matched: HashSet<&Value> = values.iter().skip(1).collect();
                let attr_decl = self.catalog.get_by_id(self.base.attr).expect("base");
                let mut subjects = HashSet::new();
                for mut row in self.project_predicate(&store, &snap, attr_decl, derived) {
                    self.retain_live(&mut row.assertions, &killed);
                    if row.assertions.is_empty() {
                        continue;
                    }
                    if let [Value::Id(s), Value::Str(k), v] = &row.key.tuple[..] {
                        if k.as_str() == key.as_str() && matched.contains(v) {
                            subjects.insert(*s);
                        }
                    }
                }
                Some(subjects)
            }
            _ => None,
        };

        // Victim enumeration over every declared predicate's LIVE rows.
        let mut victims: Vec<u128> = Vec::new();
        let mut max_victim_tick: Option<u64> = None;
        for decl in self.catalog.iter() {
            match scope.predicate {
                Some(p) => {
                    if decl.id != p {
                        continue;
                    }
                }
                // `None = все предикаты автора` (§5.5) reads over the author's
                // DATA facts: the reserved supersedes ledger is NOT in a
                // blanket scope — otherwise every repeated `All` supersede
                // would kill the author's own prior supersessions and
                // RESURRECT the very facts it retracted (oscillation, caught
                // by the battery). Superseding a supersede-assertion (the
                // §2.4 recursion) stays expressible by NAMING the predicate:
                // `predicate: Some(supersedes)`. Ledger round-010 D10a.
                None => {
                    if decl.id == self.base.supersedes {
                        continue;
                    }
                }
            }
            for mut row in self.project_predicate(&store, &snap, decl, derived) {
                self.retain_live(&mut row.assertions, &killed);
                if row.assertions.is_empty() {
                    continue;
                }
                // Subject column: c0, except incoming (c1 = the edge source —
                // the record owner; D10).
                let subject_col = usize::from(decl.name == "incoming");
                let subject = match row.key.tuple.get(subject_col) {
                    Some(Value::Id(s)) => *s,
                    _ => continue,
                };
                let in_scope = match &scope.subject_set {
                    SubjectSet::All => true,
                    SubjectSet::Explicit(ids) => ids.contains(&subject),
                    SubjectSet::ByAttr { .. } => by_attr_subjects
                        .as_ref()
                        .expect("resolved above")
                        .contains(&subject),
                };
                if !in_scope {
                    continue;
                }
                for a in &row.assertions {
                    if a.author != scope.author {
                        continue; // §4.2: foreign assertions are NEVER touched
                    }
                    max_victim_tick = Some(max_victim_tick.unwrap_or(0).max(a.tick));
                    victims.push(aid(row.fid, &author_name, a.tick));
                }
            }
        }
        drop(store);

        // E-SUP-001 first arm (D11): strict tick monotonicity, whole-op abort.
        if let Some(max_tick) = max_victim_tick {
            if at_tick <= max_tick {
                return Err(FactStoreError {
                    code: "E-SUP-001",
                    detail: format!(
                        "supersede at_tick {at_tick} is not strictly greater than the newest \
                         victim assertion tick {max_tick} (§2.4 — aid contains tick; this is \
                         what makes supersedes cycles impossible)"
                    ),
                });
            }
        }
        if victims.is_empty() {
            let version = self.manifest.lock().unwrap().current().version;
            return Ok(CommitToken { version });
        }
        victims.sort_unstable();
        victims.dedup();

        let records: Vec<NodeRecordV2> = victims
            .iter()
            .map(|&aid_old| self.supersedes_record(aid_old, &author_name, at_tick))
            .collect::<FactResult<_>>()?;
        self.commit_derived(records, Vec::new(), at_tick)
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
        // Killed set + regime BEFORE taking the store lock (both take their own
        // short read locks; std RwLock re-entrant reads can deadlock against a
        // queued writer).
        let killed = self.superseded_set(payload).clone();
        let derived = self.derived_present(payload);
        let store = self.store.read().unwrap();
        let snap = &payload.snap;

        // 1. Every live fact (the projected logical state, supersedes facts
        //    included — they are ordinary facts), through the SAME §2.4
        //    liveness rule live_filter applies (D14; divergence aborts, D3).
        let mut rows: Vec<FactRow> = Vec::new();
        for decl in self.catalog.iter() {
            rows.extend(self.project_predicate(&store, snap, decl, derived));
        }
        rows.retain_mut(|row| {
            self.retain_live(&mut row.assertions, &killed);
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
        if node_type == SUPERSEDES_NODE_TYPE {
            // D1 forgery guard: the reserved carrier of supersession truth can
            // only be written through the E-SUP-001 boundary (supersede() /
            // FactGroup::Supersedes), never smuggled in as an ordinary node.
            return Err(FactStoreError {
                code: "E-SUP-001",
                detail: format!(
                    "node_type '{SUPERSEDES_NODE_TYPE}' is the reserved supersession carrier; \
                     write supersedes facts through supersede() or FactGroup::Supersedes"
                ),
            });
        }
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

    /// The reserved supersedes record of `supersedes(aid(aid_old, author,
    /// tick), aid_old)` (D1/D2): record id = fid of the tuple (record identity
    /// ≡ fact identity), routed to the reserved virtual file.
    fn supersedes_record(
        &self,
        aid_old: u128,
        author_name: &str,
        tick: u64,
    ) -> FactResult<NodeRecordV2> {
        let aid_new = aid(aid_old, author_name, tick);
        self.supersedes_record_of(aid_new, aid_old, author_name, tick)
    }

    fn supersedes_record_of(
        &self,
        aid_new: u128,
        aid_old: u128,
        author_name: &str,
        tick: u64,
    ) -> FactResult<NodeRecordV2> {
        let tuple = [Value::Id(aid_new), Value::Id(aid_old)];
        let record_fid = fid(PERSPECTIVE_MAIN_NAME, "supersedes", &tuple)?;
        let mut meta = serde_json::Map::new();
        meta.insert(
            SUPERSEDES_META_NEW.to_string(),
            serde_json::Value::String(format!("{aid_new:032x}")),
        );
        meta.insert(
            SUPERSEDES_META_OLD.to_string(),
            serde_json::Value::String(format!("{aid_old:032x}")),
        );
        meta.insert(
            "_source".to_string(),
            serde_json::Value::String(author_name.to_string()),
        );
        meta.insert("_generation".to_string(), serde_json::Value::from(tick));
        Ok(NodeRecordV2 {
            semantic_id: String::new(),
            id: record_fid,
            node_type: SUPERSEDES_NODE_TYPE.to_string(),
            name: String::new(),
            file: SUPERSEDES_FILE.to_string(),
            content_hash: 0,
            metadata: serde_json::Value::Object(meta).to_string(),
        })
    }

    /// The aid → (tick, author) map of a fresh snapshot's ENTIRE assertion set
    /// (raw — dead assertions included: re-superseding a dead aid is legal,
    /// D11's boundary only needs the victim's identity to exist and be
    /// provable).
    fn assertion_ticks_snapshot(&self) -> HashMap<u128, (u64, AuthorId)> {
        let store = self.store.read().unwrap();
        let snap = {
            let manifest = self.manifest.lock().unwrap();
            store.snapshot(&manifest)
        };
        let derived = self.derived_in(&store, &snap);
        let mut rows: Vec<FactRow> = Vec::new();
        for decl in self.catalog.iter() {
            rows.extend(self.project_predicate(&store, &snap, decl, derived));
        }
        // Names AFTER projecting — projection interns first-seen authors.
        let names = self.author_names_snapshot();
        let mut ticks = HashMap::new();
        for row in &rows {
            for a in &row.assertions {
                let name = names
                    .get(a.author.0 as usize)
                    .expect("interned during projection");
                ticks.insert(aid(a.fid, name, a.tick), (a.tick, a.author));
            }
        }
        ticks
    }

    /// D12: one direct `supersedes/2` assert, subject to the D11 boundary AND
    /// the §4.2 author scope (a batch may supersede ONLY its own author's
    /// assertions — «Чужие ассершны не трогаются никогда»).
    fn build_supersedes_record(
        &self,
        fact: &super::GroupFact,
        author: AuthorId,
        author_name: &str,
        tick: u64,
        ticks: &HashMap<u128, (u64, AuthorId)>,
    ) -> FactResult<NodeRecordV2> {
        for v in fact.tuple.iter() {
            crate::derive::canon::validate_canonical(v)?;
        }
        if fact.predicate != self.base.supersedes {
            let name = self
                .catalog
                .get_by_id(fact.predicate)
                .map(|d| d.name.clone())
                .unwrap_or_else(|| format!("{:?}", fact.predicate));
            return Err(FactStoreError::cap(
                "record-vocabulary",
                format!("Supersedes groups accept supersedes/2 only, got '{name}'"),
            ));
        }
        let (aid_new, aid_old) = match &fact.tuple[..] {
            [Value::Id(new), Value::Id(old)] => (*new, *old),
            other => {
                return Err(FactStoreError::cap(
                    "record-vocabulary",
                    format!("supersedes/2 tuple must be [Id, Id], got {other:?}"),
                ))
            }
        };
        // E-SUP-001 (D11): the victim must resolve in the pre-commit snapshot
        // — an unresolvable aid makes tick monotonicity unprovable — and the
        // batch tick must be STRICTLY greater than the victim's.
        let Some(&(victim_tick, victim_author)) = ticks.get(&aid_old) else {
            return Err(FactStoreError {
                code: "E-SUP-001",
                detail: format!(
                    "supersedes victim aid {aid_old:x} does not resolve to any known assertion \
                     in the pre-commit snapshot — tick monotonicity is unprovable"
                ),
            });
        };
        // §4.2 author scope is ABSOLUTE on every write path into the reserved
        // predicate: only the asserting author's own assertions may be killed.
        if victim_author != author {
            return Err(FactStoreError {
                code: "E-SUP-001",
                detail: format!(
                    "supersedes victim aid {aid_old:x} belongs to a FOREIGN author — a producer \
                     supersedes only its OWN assertions (§4.2)"
                ),
            });
        }
        if tick <= victim_tick {
            return Err(FactStoreError {
                code: "E-SUP-001",
                detail: format!(
                    "supersedes tick {tick} is not strictly greater than the victim assertion's \
                     tick {victim_tick} (§2.4 — this is what makes cycles impossible)"
                ),
            });
        }
        self.supersedes_record_of(aid_new, aid_old, author_name, tick)
    }

    /// Test seam (round-011-pre E11): run the resolution with an OVERRIDDEN
    /// priority table (`Some(&[])` = pure R-1: tick → canon-order → fid)
    /// without touching the production decl — the empty-table degeneration
    /// and the real-base counterfactual legs run through this.
    #[cfg(test)]
    pub(crate) fn resolve_functional_with_priority(
        &self,
        s: &Snapshot,
        p: CatalogPredicateId,
        persp: PerspectiveId,
        subject: u128,
        priority: &[AuthorId],
    ) -> FactResult<Option<(FactRow, Vec<FactKey>)>> {
        self.resolve_functional_with(s, p, persp, subject, Some(priority))
    }

    /// The R-1a resolution core (round-011-pre E1/E5). Pure function of
    /// (snapshot live set, catalog decl / `priority_override`, author names):
    /// independent of shard layout, segment order, insertion order and
    /// assertion-vector order.
    fn resolve_functional_with(
        &self,
        s: &Snapshot,
        p: CatalogPredicateId,
        persp: PerspectiveId,
        subject: u128,
        priority_override: Option<&[AuthorId]>,
    ) -> FactResult<Option<(FactRow, Vec<FactKey>)>> {
        let decl = self.read_decl(p)?;
        if decl.cardinality != Cardinality::Functional {
            // E7: a caller contract violation, not a capability gap — the
            // predicate's declared cardinality says its subjects are
            // multi-valued, so "the one live value" does not exist as a
            // question (typed, never a panic, never a silent None).
            return Err(FactStoreError {
                code: "E-FUNC-002",
                detail: format!(
                    "resolve_functional on MultiValued predicate '{}' — cardinality is \
                     declared in the catalog (§2.3); only Functional predicates resolve",
                    decl.name
                ),
            });
        }
        let pred_name = decl.name.clone();
        let priority: Vec<AuthorId> = priority_override
            .map(<[AuthorId]>::to_vec)
            .unwrap_or_else(|| decl.author_priority.to_vec());
        let payload = self.payload(s)?;
        // §5.4a exact-match: a perspective with no facts is a valid EMPTY
        // answer (only main has facts pre-P6), checked after decl validation
        // so errors stay typed regardless of perspective.
        if persp != PERSPECTIVE_MAIN {
            return Ok(None);
        }
        // Killed set BEFORE our own store lock (it takes its own short read
        // lock; std RwLock re-entrant reads can deadlock against a queued
        // writer — the canonical_state_sha precedent).
        let killed = self.superseded_set(payload);
        let store = self.store.read().unwrap();
        let versions = store
            .node_versions_of_at(&payload.snap, subject)
            .map_err(store_err)?;
        drop(store);
        // Candidate dedup by aid identity (value, author-carrier, tick) —
        // newest-first input, first wins (same-aid re-write: M1 is P7).
        let mut seen: HashSet<(String, Option<String>, u64)> = HashSet::new();
        let mut rows: Vec<FactRow> = Vec::new();
        for (rec, fields) in versions {
            if rec.node_type == SUPERSEDES_NODE_TYPE {
                continue; // reserved records never project as node/type facts
            }
            let (source, generation) = provenance(&rec.metadata);
            if !seen.insert((rec.node_type.clone(), source, generation.unwrap_or(0))) {
                continue;
            }
            rows.push(self.node_row_with(&pred_name, &rec, fields.as_ref()));
        }
        // fid-major grouping + §2.4 liveness: resolution reads LIVE
        // assertions only (supersession interplay, E9).
        let mut rows = self.group_rows(rows);
        rows.retain_mut(|row| {
            self.retain_live(&mut row.assertions, killed);
            !row.assertions.is_empty()
        });
        // Deterministic row order regardless of segment order.
        rows.sort_by_key(|row| row.fid);
        if rows.is_empty() {
            return Ok(None);
        }
        if rows.len() == 1 {
            // Agreement: all live assertions on ONE fid — NO conflict.
            let row = rows.pop().expect("one row");
            return Ok(Some((row, Vec::new())));
        }

        // ≥2 distinct live fids: the R-1a total order as successive filters
        // over the live candidate ASSERTIONS (E1 — a pairwise mixed
        // listed/unlisted comparator would not be transitive).
        struct Cand {
            row: usize,
            tick: u64,
            author: AuthorId,
            fid: u128,
        }
        let mut cands: Vec<Cand> = rows
            .iter()
            .enumerate()
            .flat_map(|(i, row)| {
                row.assertions.iter().map(move |a| Cand {
                    row: i,
                    tick: a.tick,
                    author: a.author,
                    fid: a.fid,
                })
            })
            .collect();
        // F1: max tick (freshness dominates — R-1a ground (d)).
        let max_tick = cands.iter().map(|c| c.tick).max().expect("non-empty");
        cands.retain(|c| c.tick == max_tick);
        // F2: the priority table — applies IFF every survivor's author is
        // listed AND not all at one rank; otherwise skipped (the doc's
        // partial order: unlisted-vs-listed / both-unlisted / same-author =
        // undecided; no "listed beats everyone" surprise).
        if cands.len() > 1 && !priority.is_empty() {
            let ranks: Vec<Option<usize>> = cands
                .iter()
                .map(|c| priority.iter().position(|&x| x == c.author))
                .collect();
            if ranks.iter().all(Option::is_some) {
                let ranks: Vec<usize> = ranks.into_iter().map(Option::unwrap).collect();
                let min = *ranks.iter().min().expect("non-empty");
                let max = *ranks.iter().max().expect("non-empty");
                if min != max {
                    let mut keep = ranks.iter().map(|&r| r == min);
                    cands.retain(|_| keep.next().expect("aligned"));
                }
            }
        }
        // F3: author canon-order — LESSER canonical NAME in canon Str order
        // wins (shortlex cmp_len_prefixed via Ord-for-Value, NOT plain
        // str::cmp).
        if cands.len() > 1 {
            let authors = self.authors.read().unwrap();
            let canon_name = |a: AuthorId| -> Value {
                Value::Str(
                    authors
                        .name(a)
                        .expect("interned during projection")
                        .to_string(),
                )
            };
            let min_name = cands
                .iter()
                .map(|c| canon_name(c.author))
                .min()
                .expect("non-empty");
            cands.retain(|c| canon_name(c.author) == min_name);
        }
        // F4: min fid — total by construction (survivors share (tick,
        // author); same-(fid, author, tick) is one aid, so fids are
        // distinct). The read side ALWAYS decides: the read-side E-FUNC-001
        // arm is unreachable (round-011-pre E1, pinned by test).
        let winner = cands
            .iter()
            .min_by_key(|c| c.fid)
            .expect("non-empty after filters");
        let winner_row = winner.row;
        let winner_fid = rows[winner_row].fid;
        let winner_tick = winner.tick;

        // DEV-1 superset emission: one conflict/5 FactKey per LOSER FACT on
        // EVERY multi-live resolution (k live facts → k−1 keys), loser-fid
        // ascending for determinism. Tick column = the WINNER's tick (DEV-4).
        let winner_tick_int = i64::try_from(winner_tick)
            .expect("winner tick fits the §2.3 Int conflict column");
        let conflicts: Vec<FactKey> = rows
            .iter()
            .enumerate()
            .filter(|&(i, _)| i != winner_row)
            .map(|(_, row)| FactKey {
                perspective: self.audit_persp,
                predicate: self.base.conflict,
                tuple: vec![
                    Value::Id(subject),
                    Value::Str(pred_name.clone()),
                    Value::Id(winner_fid),
                    Value::Id(row.fid),
                    Value::Int(winner_tick_int),
                ]
                .into(),
            })
            .collect();
        let winner_row = rows.swap_remove(winner_row);
        Ok(Some((winner_row, conflicts)))
    }

    /// The facts commit path (D4): additive derived commit, v3 segments,
    /// provenance.generation = tick (D5), Bool tag, TX_OPEN (D6 — P4 writes no
    /// cache).
    fn commit_derived(
        &self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        tick: u64,
    ) -> FactResult<CommitToken> {
        let fields = DerivedFields {
            provenance: ProvenanceV2 {
                rule_ast_hash: 0,
                generation: tick,
            },
            tag: TagV2::bool_one(),
            tx_created: 0,
            tx_invalidated: TX_OPEN,
        };
        let nodes: Vec<(NodeRecordV2, DerivedFields)> =
            nodes.into_iter().map(|n| (n, fields.clone())).collect();
        let edges: Vec<(EdgeRecordV2, DerivedFields)> =
            edges.into_iter().map(|e| (e, fields.clone())).collect();
        let mut store = self.store.write().unwrap();
        let mut manifest = self.manifest.lock().unwrap();
        let version = store
            .commit_batch_derived(nodes, edges, &mut manifest)
            .map_err(store_err)?;
        Ok(CommitToken { version })
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

    /// P4 flip (spec contract (9), ledger round-010-pre H10): supersession is
    /// REAL — the E-CAP-001("supersession") rejection ceases to exist. The
    /// P2-shaped call (at_tick 1 ≤ the fixture's newest analyzer tick 3) now
    /// hits the E-SUP-001 tick boundary instead; a properly-ticked call
    /// commits (full behavior in the supersession battery below).
    #[test]
    fn supersede_flipped_from_e_cap_001_to_real() {
        let fs = fixture_store();
        let scope = SupersedeScope {
            author: fs.intern_author("analyzer"),
            perspective: PERSPECTIVE_MAIN,
            predicate: None,
            subject_set: SubjectSet::All,
        };
        let err = fs.supersede(scope.clone(), 1).unwrap_err();
        assert_eq!(err.code, "E-SUP-001", "{}", err.detail);
        fs.supersede(scope, 100).expect("monotone tick supersedes");
    }

    /// P5 flip (round-011-pre E7, the round's ONLY pre-existing expectation
    /// change): the E-CAP-001("functional-resolution") stub ceases to exist —
    /// resolve_functional on the Functional `type` predicate now RESOLVES
    /// (single-record subject 11 → agreement, no conflict), and calling it on
    /// a MultiValued predicate is the typed E-FUNC-002 contract violation
    /// (never a panic, never a silent None) — see the P5 battery below.
    #[test]
    fn resolve_functional_flipped_from_e_cap_001_to_real() {
        let fs = fixture_store();
        let s = fs.snapshot();
        let (row, conflicts) = fs
            .resolve_functional(&s, base_id(&fs, "type"), PERSPECTIVE_MAIN, 11)
            .expect("Functional predicate resolves")
            .expect("subject 11 exists");
        assert_eq!(row.key.tuple[1], Value::Str("FUNCTION".into()));
        assert!(conflicts.is_empty(), "single-fact subject: no conflict");
        for name in ["edge", "incoming", "attr", "supersedes"] {
            let err = fs
                .resolve_functional(&s, base_id(&fs, name), PERSPECTIVE_MAIN, 11)
                .unwrap_err();
            assert_eq!(err.code, "E-FUNC-002", "{name}: {}", err.detail);
        }
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

    /// Round-008 R1, REVERSED for coexisting authors by P4 (ledger D8): two
    /// AUTHORS re-asserting the SAME edge key are now two coexisting
    /// assertions of ONE fact — and every read path (full run + all four keyed
    /// paths) serves the SAME two-assertion row (prefix_scan is a window of
    /// sorted_run at FactRow level, provenance included). Same-(author, tick)
    /// newest-wins stays (M1 is P7).
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
        // Same-(author, tick) re-assert stays newest-wins (M1 dedup is P7's
        // refinement; the projection must not mint a duplicate aid).
        fs.assert_batch(edge_group("writer-v2", 9))
            .expect("same-aid re-assert");
        let s = fs.snapshot();
        let prov = |rows: Vec<FactRow>, label: &str| -> (u128, Vec<(String, u64)>) {
            assert_eq!(rows.len(), 1, "{label}: exactly one row (one fid)");
            let asserts: Vec<(String, u64)> = rows[0]
                .assertions
                .iter()
                .map(|a| (fs.author_name(a.author).expect("interned"), a.tick))
                .collect();
            (rows[0].fid, asserts)
        };
        let want = vec![
            ("writer-v1".to_string(), 1u64),
            ("writer-v2".to_string(), 9u64),
        ];
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
            full.1, want,
            "the full run carries BOTH coexisting authors' assertions (D8)"
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
                keyed.1, want,
                "prefix_scan({pred}, {order:?}) must serve the SAME assertion set"
            );
        }
        // `incoming` shares the fid of its own tuple, `edge` its own — but each
        // path of one predicate yields the SAME (fid, assertions).
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
        assert_eq!(keyed_edge, full, "one fid, one assertion SET, path-independent");
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
    fn live_filter_passes_all_p2_rows() {
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
    }

    /// P4 semantics change vs P2 (pre-registered, ledger round-010-pre D3):
    /// a cache-dead assertion (`tx_invalidated != TX_OPEN`) with NO live
    /// `supersedes(_, aid)` fact in the snapshot is DIVERGENCE between the
    /// physical cache and the logical truth — live_filter ABORTS E-SUP-001
    /// (P2 silently dropped it), never silently picks one truth.
    #[test]
    #[should_panic(expected = "E-SUP-001")]
    fn live_filter_divergent_cache_dead_aborts_e_sup_001() {
        let fs = fixture_store();
        let s = fs.snapshot();
        let rows = collect(fs.sorted_run(
            &s,
            base_id(&fs, "edge"),
            PERSPECTIVE_MAIN,
            SortOrder::Forward,
        ));
        let mut dead = rows[0].clone();
        dead.assertions[0].tx_invalidated = 5;
        let _ = fs
            .live_filter(&s, Box::new(vec![dead].into_iter()))
            .count();
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

    // ── P4 supersession battery (ledger round-010-pre H2–H4, D1–D12) ──

    /// Live rows of `name` through the ONLY legal liveness path (§2.4).
    fn live_run(fs: &LsmFactStore, s: &Snapshot, name: &str) -> Vec<FactRow> {
        let rows = collect(fs.sorted_run(&s2(s), base_id(fs, name), PERSPECTIVE_MAIN, SortOrder::Forward));
        fs.live_filter(&s2(s), Box::new(rows.into_iter())).collect()
    }

    // (identity helper so live_run can reborrow the snapshot twice)
    fn s2(s: &Snapshot) -> &Snapshot {
        s
    }

    fn authors_of(fs: &LsmFactStore, row: &FactRow) -> Vec<(String, u64)> {
        row.assertions
            .iter()
            .map(|a| (fs.author_name(a.author).expect("interned"), a.tick))
            .collect()
    }

    fn assert_nodes(fs: &LsmFactStore, author: &str, tick: u64, groups: Vec<FactGroup>) {
        fs.assert_batch(AssertBatch {
            perspective: PERSPECTIVE_MAIN,
            author: fs.intern_author(author),
            tick,
            groups,
        })
        .expect("facts write");
    }

    fn scope_all(fs: &LsmFactStore, author: &str) -> SupersedeScope {
        SupersedeScope {
            author: fs.intern_author(author),
            perspective: PERSPECTIVE_MAIN,
            predicate: None,
            subject_set: SubjectSet::All,
        }
    }

    /// H3 core (§4.2): two authors assert ONE fid; superseding All as one
    /// author kills EXACTLY that author's assertions — the fact stays live
    /// with the foreign assertion, everywhere (node/type/attr).
    #[test]
    fn supersede_all_kills_only_own_assertions() {
        let fs = LsmFactStore::ephemeral(2);
        let group = |fs: &LsmFactStore| {
            node_group(fs, 1, "FUNCTION", &[("name", Value::Str("shared".into()))])
        };
        assert_nodes(&fs, "alice", 1, vec![group(&fs)]);
        assert_nodes(&fs, "bob", 2, vec![group(&fs)]);
        let s = fs.snapshot();
        let rows = live_run(&fs, &s, "node");
        assert_eq!(rows.len(), 1, "one fid");
        assert_eq!(
            authors_of(&fs, &rows[0]),
            vec![("alice".to_string(), 1), ("bob".to_string(), 2)],
            "coexisting-author assertions are REAL (D8)"
        );
        let sha_before = fs.canonical_state_sha(&s);

        fs.supersede(scope_all(&fs, "alice"), 10).expect("supersede");
        let s = fs.snapshot();
        for name in ["node", "type", "attr"] {
            let rows = live_run(&fs, &s, name);
            assert_eq!(rows.len(), 1, "{name}: fact stays live");
            assert_eq!(
                authors_of(&fs, &rows[0]),
                vec![("bob".to_string(), 2)],
                "{name}: EXACTLY the foreign assertion survives (§4.2)"
            );
        }
        // The logical state moved (unlike compaction physics).
        assert_ne!(sha_before, fs.canonical_state_sha(&s));
        // No scope naming alice can ever touch bob: alice's repeated supersede
        // at a higher tick is a no-op now (her assertions are already dead).
        fs.supersede(scope_all(&fs, "alice"), 20).expect("no-op");
        let s = fs.snapshot();
        let rows = live_run(&fs, &s, "node");
        assert_eq!(authors_of(&fs, &rows[0]), vec![("bob".to_string(), 2)]);
    }

    /// H2a (D11): at_tick ≤ a victim's tick aborts the WHOLE operation
    /// pre-commit — typed E-SUP-001, sha byte-identical.
    #[test]
    fn supersede_tick_boundary_aborts_whole_op() {
        let fs = LsmFactStore::ephemeral(2);
        assert_nodes(&fs, "alice", 7, vec![node_group(&fs, 1, "FUNCTION", &[])]);
        let s = fs.snapshot();
        let sha_before = fs.canonical_state_sha(&s);
        for bad_tick in [0, 6, 7] {
            let err = fs.supersede(scope_all(&fs, "alice"), bad_tick).unwrap_err();
            assert_eq!(err.code, "E-SUP-001", "{}", err.detail);
        }
        let s = fs.snapshot();
        assert_eq!(
            sha_before,
            fs.canonical_state_sha(&s),
            "aborted supersede leaves the store byte-identical"
        );
        fs.supersede(scope_all(&fs, "alice"), 8).expect("strictly greater tick");
    }

    /// H2a, direct-assert arm (D12): the same E-SUP-001 boundary guards
    /// `FactGroup::Supersedes` — tick monotonicity, victim resolvability, and
    /// the §4.2 author scope; a cycle is unconstructible.
    #[test]
    fn direct_supersedes_asserts_guarded_by_e_sup_001() {
        let fs = LsmFactStore::ephemeral(2);
        assert_nodes(&fs, "alice", 1, vec![node_group(&fs, 1, "FUNCTION", &[])]);
        let node_fid = super::super::fid(
            "main",
            "node",
            &[Value::Id(1), Value::Str("FUNCTION".into())],
        )
        .unwrap();
        let victim = super::super::aid(node_fid, "alice", 1);
        let sup_group = |aid_new: u128, aid_old: u128| FactGroup::Supersedes {
            fact: super::super::GroupFact {
                predicate: base_id(&fs, "supersedes"),
                tuple: vec![Value::Id(aid_new), Value::Id(aid_old)].into(),
            },
        };
        let batch = |author: &str, tick: u64, groups: Vec<FactGroup>| AssertBatch {
            perspective: PERSPECTIVE_MAIN,
            author: fs.intern_author(author),
            tick,
            groups,
        };
        // Tick violation: batch tick == victim tick.
        let err = fs
            .assert_batch(batch("alice", 1, vec![sup_group(9, victim)]))
            .unwrap_err();
        assert_eq!(err.code, "E-SUP-001", "{}", err.detail);
        // Unresolvable victim.
        let err = fs
            .assert_batch(batch("alice", 5, vec![sup_group(9, 0xdead_beef)]))
            .unwrap_err();
        assert_eq!(err.code, "E-SUP-001", "{}", err.detail);
        assert!(err.detail.contains("does not resolve"), "{}", err.detail);
        // Foreign victim (§4.2): bob cannot kill alice's assertion.
        let err = fs
            .assert_batch(batch("bob", 5, vec![sup_group(9, victim)]))
            .unwrap_err();
        assert_eq!(err.code, "E-SUP-001", "{}", err.detail);
        assert!(err.detail.contains("FOREIGN"), "{}", err.detail);
        // A valid direct supersede kills the assertion.
        fs.assert_batch(batch("alice", 2, vec![sup_group(9, victim)]))
            .expect("monotone direct supersede");
        let s = fs.snapshot();
        assert!(live_run(&fs, &s, "node").is_empty(), "victim dead");
        // Cycle unconstructible: superseding the supersede-assertion needs a
        // STRICTLY greater tick — the same tick is rejected, so
        // supersedes(x,y) ∧ supersedes(y,x) can never close.
        let sup_rows = live_run(&fs, &s, "supersedes");
        assert_eq!(sup_rows.len(), 1);
        let s1_aid = super::super::aid(sup_rows[0].fid, "alice", 2);
        let err = fs
            .assert_batch(batch("alice", 2, vec![sup_group(11, s1_aid)]))
            .unwrap_err();
        assert_eq!(err.code, "E-SUP-001", "{}", err.detail);
    }

    /// H4 (§2.4 definitional recursion): superseding the supersede-assertion
    /// itself resurrects the originally-superseded assertion; a re-assert
    /// after supersession is a NEW aid and lives.
    #[test]
    fn recursive_liveness_resurrects_and_reassert_lives() {
        let fs = LsmFactStore::ephemeral(2);
        assert_nodes(&fs, "alice", 1, vec![node_group(&fs, 7, "FUNCTION", &[])]);
        fs.supersede(scope_all(&fs, "alice"), 2).expect("first supersede");
        {
            let s = fs.snapshot();
            assert!(live_run(&fs, &s, "node").is_empty(), "fact dead after supersede");
        }
        // Supersede the supersede-assertions themselves (predicate-scoped).
        let scope = SupersedeScope {
            author: fs.intern_author("alice"),
            perspective: PERSPECTIVE_MAIN,
            predicate: Some(base_id(&fs, "supersedes")),
            subject_set: SubjectSet::All,
        };
        fs.supersede(scope, 3).expect("supersede the supersedes");
        {
            let s = fs.snapshot();
            let rows = live_run(&fs, &s, "node");
            assert_eq!(rows.len(), 1, "original assertion is LIVE again (§2.4 recursion)");
            assert_eq!(authors_of(&fs, &rows[0]), vec![("alice".to_string(), 1)]);
        }
        // Independent arm: re-assert AFTER a supersession = new aid, fact live.
        let fs = LsmFactStore::ephemeral(2);
        assert_nodes(&fs, "alice", 1, vec![node_group(&fs, 8, "FUNCTION", &[])]);
        fs.supersede(scope_all(&fs, "alice"), 2).expect("supersede");
        assert_nodes(&fs, "alice", 4, vec![node_group(&fs, 8, "FUNCTION", &[])]);
        let s = fs.snapshot();
        let rows = live_run(&fs, &s, "node");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            authors_of(&fs, &rows[0]),
            vec![("alice".to_string(), 4)],
            "the tick-4 re-assert lives; the tick-1 assertion stays dead"
        );
    }

    /// H3 ByAttr arm (§5.5/D10): `ByAttr{attr, ["file", …changedFiles]}`
    /// reproduces the reanalysis contract — kills exactly the author's
    /// assertions on subjects in the changed files, edges (and their incoming
    /// views) included; foreign authors and other files untouched.
    #[test]
    fn supersede_by_attr_reproduces_reanalysis_contract() {
        let fs = LsmFactStore::ephemeral(2);
        assert_nodes(
            &fs,
            "alice",
            1,
            vec![
                node_group(&fs, 10, "FUNCTION", &[("file", Value::Str("a.js".into()))]),
                node_group(&fs, 11, "FUNCTION", &[("file", Value::Str("b.js".into()))]),
            ],
        );
        fs.assert_batch(AssertBatch {
            perspective: PERSPECTIVE_MAIN,
            author: fs.intern_author("alice"),
            tick: 2,
            groups: vec![FactGroup::Edge {
                fact: super::super::GroupFact {
                    predicate: base_id(&fs, "edge"),
                    tuple: vec![Value::Id(10), Value::Id(11), Value::Str("CALLS".into())].into(),
                },
            }],
        })
        .expect("edge");
        assert_nodes(
            &fs,
            "bob",
            3,
            vec![node_group(&fs, 20, "FUNCTION", &[("file", Value::Str("a.js".into()))])],
        );

        fs.supersede(
            SupersedeScope {
                author: fs.intern_author("alice"),
                perspective: PERSPECTIVE_MAIN,
                predicate: None,
                subject_set: SubjectSet::ByAttr {
                    pred: base_id(&fs, "attr"),
                    values: vec![Value::Str("file".into()), Value::Str("a.js".into())],
                },
            },
            10,
        )
        .expect("ByAttr supersede");

        let s = fs.snapshot();
        let nodes = live_run(&fs, &s, "node");
        let ids: Vec<&Value> = nodes.iter().map(|r| &r.key.tuple[0]).collect();
        assert!(!ids.contains(&&Value::Id(10)), "alice's a.js node dead");
        assert!(ids.contains(&&Value::Id(11)), "alice's b.js node live");
        assert!(ids.contains(&&Value::Id(20)), "bob's a.js node live (§4.2)");
        // The edge FROM the superseded subject died, on both views.
        assert!(live_run(&fs, &s, "edge").is_empty(), "edge 10→11 dead");
        assert!(live_run(&fs, &s, "incoming").is_empty(), "incoming view dead too");
        // ByAttr with a non-attr predicate is a typed P6 rejection.
        let err = fs
            .supersede(
                SupersedeScope {
                    author: fs.intern_author("alice"),
                    perspective: PERSPECTIVE_MAIN,
                    predicate: None,
                    subject_set: SubjectSet::ByAttr {
                        pred: base_id(&fs, "node"),
                        values: vec![Value::Str("file".into())],
                    },
                },
                20,
            )
            .unwrap_err();
        assert_eq!(err.code, "E-CAP-001");
        assert!(err.detail.contains("per-attribute-predicates"), "{}", err.detail);
    }

    /// Two live CONFLICTING Functional assertions are LEGAL in P4 (arbitration
    /// is P5, §10.4); author-scoped supersession resolves only its own side.
    #[test]
    fn conflicting_functional_fids_coexist_and_scope_by_author() {
        let fs = LsmFactStore::ephemeral(2);
        assert_nodes(&fs, "alice", 1, vec![node_group(&fs, 30, "GLOBAL_DEFINITION", &[])]);
        assert_nodes(&fs, "bob", 2, vec![node_group(&fs, 30, "EXTERNAL_FUNCTION", &[])]);
        let s = fs.snapshot();
        assert_eq!(
            live_run(&fs, &s, "node").len(),
            2,
            "two conflicting Functional facts BOTH live (P4 — §2.3 arbitration is P5)"
        );
        fs.supersede(
            SupersedeScope {
                author: fs.intern_author("alice"),
                perspective: PERSPECTIVE_MAIN,
                predicate: None,
                subject_set: SubjectSet::Explicit(vec![30]),
            },
            10,
        )
        .expect("supersede alice");
        let s = fs.snapshot();
        let rows = live_run(&fs, &s, "node");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key.tuple[1], Value::Str("EXTERNAL_FUNCTION".into()));
        assert_eq!(authors_of(&fs, &rows[0]), vec![("bob".to_string(), 2)]);
    }

    /// D1 forgery guard: the reserved carrier cannot be smuggled through a
    /// node group — only the E-SUP-001 boundary writes it.
    #[test]
    fn reserved_supersedes_node_type_rejected_in_node_groups() {
        let fs = fixture_store();
        let err = fs
            .assert_batch(batch(
                &fs,
                vec![node_group(&fs, 999, SUPERSEDES_NODE_TYPE, &[])],
            ))
            .unwrap_err();
        assert_eq!(err.code, "E-SUP-001");
        assert!(err.detail.contains("reserved"), "{}", err.detail);
    }

    /// D1 visibility rule: reserved records surface in the LEGACY node
    /// aggregates as rows (§9.4) and NEVER leak into node/type/attr facts;
    /// node-fact count == legacy node_count − reserved-record count.
    #[test]
    fn reserved_records_legacy_visible_but_never_fact_leak() {
        let fs = LsmFactStore::ephemeral(2);
        assert_nodes(
            &fs,
            "alice",
            1,
            vec![node_group(&fs, 40, "FUNCTION", &[("name", Value::Str("f".into()))])],
        );
        fs.supersede(scope_all(&fs, "alice"), 5).expect("supersede");
        let s = fs.snapshot();
        // Victims: node/2, type/2 and the name attr — three supersedes records.
        let sup = live_run(&fs, &s, "supersedes");
        assert_eq!(sup.len(), 3, "one supersedes fact per victim assertion");
        // No reserved leakage into any base relation, raw OR live.
        for name in ["node", "type", "attr"] {
            for row in collect(fs.sorted_run(&s, base_id(&fs, name), PERSPECTIVE_MAIN, SortOrder::Forward)) {
                for v in row.key.tuple.iter() {
                    if let Value::Str(sv) = v {
                        assert_ne!(sv, SUPERSEDES_NODE_TYPE, "{name}: reserved leak");
                    }
                }
            }
        }
        // Legacy view: reserved records ARE rows.
        let pinned = fs.read_snapshot_of(&s);
        let store = fs.store_read();
        let reserved = store
            .find_nodes_at(&pinned, Some(SUPERSEDES_NODE_TYPE), None)
            .len();
        assert_eq!(reserved, 3, "reserved records visible to the legacy surface");
        let node_facts = collect(fs.sorted_run(&s, base_id(&fs, "node"), PERSPECTIVE_MAIN, SortOrder::Forward)).len();
        assert_eq!(
            node_facts,
            store.node_count_at(&pinned) - reserved,
            "node facts == legacy node_count − reserved rows (D1)"
        );
    }

    /// D16 + scope hygiene: non-main perspective and unknown-author scopes are
    /// typed rejections, not partial writes.
    #[test]
    fn supersede_scope_gates_are_typed() {
        let fs = fixture_store();
        let other = fs.intern_perspective("other");
        let err = fs
            .supersede(
                SupersedeScope {
                    author: fs.intern_author("analyzer"),
                    perspective: other,
                    predicate: None,
                    subject_set: SubjectSet::All,
                },
                100,
            )
            .unwrap_err();
        assert_eq!(err.code, "E-CAP-001");
        assert!(err.detail.contains("perspectives"), "{}", err.detail);
        let err = fs
            .supersede(
                SupersedeScope {
                    author: AuthorId(999),
                    perspective: PERSPECTIVE_MAIN,
                    predicate: None,
                    subject_set: SubjectSet::All,
                },
                100,
            )
            .unwrap_err();
        assert_eq!(err.code, "E-CAT-001");
        // Unknown predicate in scope: the §3.4 unknown-id class.
        let err = fs
            .supersede(
                SupersedeScope {
                    author: fs.intern_author("analyzer"),
                    perspective: PERSPECTIVE_MAIN,
                    predicate: Some(CatalogPredicateId(999)),
                    subject_set: SubjectSet::All,
                },
                100,
            )
            .unwrap_err();
        assert_eq!(err.code, "E-CAT-002");
    }

    /// H6 stats arm: `stats(supersedes)` carries REAL live counts (the
    /// anti-join build side the P3 estimator costs); base stats are LIVE
    /// counts (post-supersession).
    #[test]
    fn stats_supersedes_and_base_are_live_counts() {
        let fs = LsmFactStore::ephemeral(2);
        assert_nodes(
            &fs,
            "alice",
            1,
            vec![
                node_group(&fs, 50, "FUNCTION", &[]),
                node_group(&fs, 51, "FUNCTION", &[]),
            ],
        );
        fs.supersede(
            SupersedeScope {
                author: fs.intern_author("alice"),
                perspective: PERSPECTIVE_MAIN,
                predicate: None,
                subject_set: SubjectSet::Explicit(vec![50]),
            },
            10,
        )
        .expect("supersede node 50");
        // First stats observation AFTER the supersede (C20 once-semantics).
        let sup = fs.stats(base_id(&fs, "supersedes"));
        assert_eq!(sup.live_facts, 2, "node/2 + type/2 victims of subject 50");
        assert_eq!(sup.live_asserts, 2);
        let node = fs.stats(base_id(&fs, "node"));
        assert_eq!(node.live_facts, 1, "only node 51 is live");
        assert_eq!(node.live_asserts, 1);
    }

    // ── P5 Functional battery (ledger round-011-pre E1–E11, X2–X9) ──

    /// One node group asserting (id, ty) by `author` at `tick`.
    fn assert_typed(fs: &LsmFactStore, author: &str, tick: u64, id: u128, ty: &str) {
        assert_nodes(fs, author, tick, vec![node_group(fs, id, ty, &[])]);
    }

    fn resolve(
        fs: &LsmFactStore,
        s: &Snapshot,
        pred: &str,
        subject: u128,
    ) -> Option<(FactRow, Vec<FactKey>)> {
        fs.resolve_functional(s, base_id(fs, pred), PERSPECTIVE_MAIN, subject)
            .expect("Functional resolution never errors on the read path")
    }

    fn winner_type(row: &FactRow) -> String {
        match &row.key.tuple[1] {
            Value::Str(t) => t.clone(),
            other => panic!("node tuple value: {other:?}"),
        }
    }

    /// E3/E4 (X9): from_parts amends node/type to Functional with the seeded
    /// pair; conflict/5 + audit perspective declared at construction; the
    /// conflict relation reads as an honest EMPTY relation (DEV-3 — no
    /// durable materialization).
    #[test]
    fn from_parts_seeds_functional_decls_conflict_and_audit() {
        let fs = fixture_store();
        let high = fs.intern_author(SEEDED_PRIORITY_HIGH);
        let low = fs.intern_author(SEEDED_PRIORITY_LOW);
        for name in ["node", "type"] {
            let decl = fs.catalog().get(name).expect("base");
            assert_eq!(decl.cardinality, Cardinality::Functional, "{name}");
            assert_eq!(
                decl.author_priority,
                vec![high, low].into_boxed_slice(),
                "{name}: exactly the ONE seeded pair (R-1a)"
            );
        }
        for name in ["edge", "incoming", "attr", "supersedes"] {
            let decl = fs.catalog().get(name).expect("declared");
            assert_eq!(decl.cardinality, Cardinality::MultiValued, "{name}");
            assert!(decl.author_priority.is_empty(), "{name}");
        }
        let conflict = fs.catalog().get("conflict").expect("declared at construction");
        assert_eq!(conflict.arity, 5);
        assert_eq!(conflict.cardinality, Cardinality::MultiValued);
        // Audit perspective interned at construction (idempotent re-intern
        // returns the same id — and it is NOT main).
        let audit = fs.intern_perspective(PERSPECTIVE_AUDIT_NAME);
        assert_ne!(audit, PERSPECTIVE_MAIN);
        assert_eq!(audit, fs.audit_persp);
        // The conflict relation is an honest empty relation on read.
        let s = fs.snapshot();
        assert!(collect(fs.sorted_run(&s, conflict.id, PERSPECTIVE_MAIN, SortOrder::Forward))
            .is_empty());
    }

    /// X3-i: max tick dominates the priority table — a NEWER tick from the
    /// LOWER-priority author wins; the conflict is still emitted (DEV-1
    /// superset: emission also when tick decides).
    #[test]
    fn resolve_step_i_max_tick_dominates_priority_table() {
        let fs = LsmFactStore::ephemeral(2);
        assert_typed(&fs, SEEDED_PRIORITY_HIGH, 1, 30, "GLOBAL_DEFINITION");
        assert_typed(&fs, SEEDED_PRIORITY_LOW, 2, 30, "EXTERNAL_FUNCTION");
        let s = fs.snapshot();
        let (row, conflicts) = resolve(&fs, &s, "node", 30).expect("two live facts");
        assert_eq!(
            winner_type(&row),
            "EXTERNAL_FUNCTION",
            "tick 2 beats the higher-priority author's tick 1 (freshness first)"
        );
        assert_eq!(conflicts.len(), 1, "superset emission: tick decided, still emitted");
    }

    /// X3-ii: the seeded table decides EXACTLY the tick-tie, and AGAINST
    /// canon-order (which would pick the shorter haskell-local-refs name);
    /// empty-table counterfactual (pure R-1) flips the winner — WHY the pair
    /// exists. "node" and "type" agree.
    #[test]
    fn resolve_step_ii_priority_decides_tick_tie_against_canon() {
        let fs = LsmFactStore::ephemeral(2);
        assert_typed(&fs, SEEDED_PRIORITY_HIGH, 1, 31, "GLOBAL_DEFINITION");
        assert_typed(&fs, SEEDED_PRIORITY_LOW, 1, 31, "EXTERNAL_FUNCTION");
        let s = fs.snapshot();
        for pred in ["node", "type"] {
            let (row, conflicts) = resolve(&fs, &s, pred, 31).expect("two live facts");
            assert_eq!(
                winner_type(&row),
                "GLOBAL_DEFINITION",
                "{pred}: the seeded pair decides the tie (R-1a)"
            );
            assert_eq!(conflicts.len(), 1);
        }
        // Empty-table counterfactual: canon shortlex picks haskell-local-refs
        // (len 18 < 23) — the R-1a falsifier's 39/39 would-be flip.
        let (row, _) = fs
            .resolve_functional_with_priority(&s, base_id(&fs, "node"), PERSPECTIVE_MAIN, 31, &[])
            .expect("resolves")
            .expect("two live facts");
        assert_eq!(
            winner_type(&row),
            "EXTERNAL_FUNCTION",
            "pure R-1 (empty table) degenerates to tick → canon → fid"
        );
    }

    /// X3-iii: unlisted-vs-listed is UNDECIDED by the table (no "listed beats
    /// everyone") — falls through to canon-order, where the short unlisted
    /// name beats the listed haskell-runtime-globals.
    #[test]
    fn resolve_step_iii_unlisted_vs_listed_falls_to_canon() {
        let fs = LsmFactStore::ephemeral(2);
        assert_typed(&fs, SEEDED_PRIORITY_HIGH, 1, 32, "GLOBAL_DEFINITION");
        assert_typed(&fs, "aa", 1, 32, "OTHER_TYPE");
        let s = fs.snapshot();
        let (row, conflicts) = resolve(&fs, &s, "node", 32).expect("two live facts");
        assert_eq!(
            winner_type(&row),
            "OTHER_TYPE",
            "table skipped (one author unlisted); canon: 'aa' < 'haskell-runtime-globals'"
        );
        assert_eq!(conflicts.len(), 1);
    }

    /// X3-iv: author canon-order is SHORTLEX (canon Str order,
    /// cmp_len_prefixed), not plain lex: 'zz' beats 'aaa'.
    #[test]
    fn resolve_step_iv_canon_shortlex_zz_beats_aaa() {
        let fs = LsmFactStore::ephemeral(2);
        assert_typed(&fs, "aaa", 1, 33, "TYPE_FROM_AAA");
        assert_typed(&fs, "zz", 1, 33, "TYPE_FROM_ZZ");
        let s = fs.snapshot();
        let (row, _) = resolve(&fs, &s, "node", 33).expect("two live facts");
        assert_eq!(
            winner_type(&row),
            "TYPE_FROM_ZZ",
            "shortlex: len 2 < len 3 — plain str::cmp would pick 'aaa'"
        );
    }

    /// X3-v (and the E6 cross-batch arm of X5): the SAME author asserting two
    /// values across TWO batches at the same tick is NOT E-FUNC-001 — both
    /// live, decided at the final min-fid step.
    #[test]
    fn resolve_step_v_min_fid_same_author_same_tick_cross_batch() {
        let fs = LsmFactStore::ephemeral(2);
        assert_typed(&fs, "alice", 1, 34, "TYPE_ONE");
        assert_typed(&fs, "alice", 1, 34, "TYPE_TWO"); // separate batch: legal
        let s = fs.snapshot();
        let (row, conflicts) = resolve(&fs, &s, "node", 34).expect("two live facts");
        let fid_of = |ty: &str| {
            super::super::fid(
                "main",
                "node",
                &[Value::Id(34), Value::Str(ty.to_string())],
            )
            .unwrap()
        };
        let expect = if fid_of("TYPE_ONE") < fid_of("TYPE_TWO") {
            "TYPE_ONE"
        } else {
            "TYPE_TWO"
        };
        assert_eq!(
            winner_type(&row),
            expect,
            "tick tie → same-author table skip → canon equal skip → min u128 fid"
        );
        assert_eq!(row.fid, fid_of("TYPE_ONE").min(fid_of("TYPE_TWO")));
        assert_eq!(conflicts.len(), 1);
    }

    /// X2: totality + determinism — the resolution is a pure function of the
    /// live set: permuting insertion order and shard count changes NOTHING
    /// (winner tuple, winner assertion, loser fid set); it always decides
    /// (Some, no error) — the read-side E-FUNC-001 arm is unreachable.
    #[test]
    fn resolve_total_and_deterministic_under_permutation() {
        let writes: [(&str, u64, &str); 3] = [
            (SEEDED_PRIORITY_HIGH, 1, "GLOBAL_DEFINITION"),
            (SEEDED_PRIORITY_LOW, 1, "EXTERNAL_FUNCTION"),
            ("zz", 1, "ZZ_TYPE"),
        ];
        let mut outcomes: Vec<(String, String, u64, Vec<u128>)> = Vec::new();
        for shards in [1u16, 2, 4] {
            // All 6 insertion orders of the three writes.
            for perm in [
                [0usize, 1, 2],
                [0, 2, 1],
                [1, 0, 2],
                [1, 2, 0],
                [2, 0, 1],
                [2, 1, 0],
            ] {
                let fs = LsmFactStore::ephemeral(shards);
                for &i in &perm {
                    let (author, tick, ty) = writes[i];
                    assert_typed(&fs, author, tick, 35, ty);
                }
                let s = fs.snapshot();
                let (row, conflicts) =
                    resolve(&fs, &s, "node", 35).expect("three live facts always decide");
                let a = &row.assertions[0];
                let mut losers: Vec<u128> = conflicts
                    .iter()
                    .map(|k| match &k.tuple[3] {
                        Value::Id(f) => *f,
                        other => panic!("loser fid column: {other:?}"),
                    })
                    .collect();
                losers.sort_unstable();
                outcomes.push((
                    winner_type(&row),
                    fs.author_name(a.author).expect("interned"),
                    a.tick,
                    losers,
                ));
            }
        }
        for o in &outcomes[1..] {
            assert_eq!(o, &outcomes[0], "layout/order/shard-invariant resolution");
        }
        // The tick-tie among {listed, listed, unlisted}: the table is skipped
        // (E1 F2 — 'zz' unlisted), canon picks 'zz' (shortest name).
        assert_eq!(outcomes[0].0, "ZZ_TYPE");
        assert_eq!(outcomes[0].3.len(), 2, "3 live facts → 2 conflict keys");
    }

    /// X4: conflict/5 emission — key shape [Id, Str(name), Id, Id, Int] in
    /// the audit perspective; k−1 keys; agreement (two authors, ONE fid) →
    /// NO conflict.
    #[test]
    fn conflict_emission_shape_agreement_and_counts() {
        let fs = LsmFactStore::ephemeral(2);
        // Agreement: same tuple, two authors → one fid, no conflict.
        assert_typed(&fs, "alice", 1, 36, "FUNCTION");
        assert_typed(&fs, "bob", 2, 36, "FUNCTION");
        let s = fs.snapshot();
        let (row, conflicts) = resolve(&fs, &s, "node", 36).expect("live");
        assert_eq!(row.assertions.len(), 2, "both authors' assertions on the one fid");
        assert!(conflicts.is_empty(), "agreement is NOT a conflict");
        // Multi-live: three types → two loser keys, canonical shape.
        let fs = LsmFactStore::ephemeral(2);
        assert_typed(&fs, "alice", 3, 37, "T_A");
        assert_typed(&fs, "bob", 2, 37, "T_B");
        assert_typed(&fs, "carol", 1, 37, "T_C");
        let s = fs.snapshot();
        let (row, conflicts) = resolve(&fs, &s, "node", 37).expect("live");
        assert_eq!(winner_type(&row), "T_A", "max tick decides");
        assert_eq!(conflicts.len(), 2, "k live facts → k−1 conflict keys");
        let audit = fs.intern_perspective(PERSPECTIVE_AUDIT_NAME);
        let conflict_pred = fs.catalog().get("conflict").unwrap().id;
        let mut seen_losers: Vec<u128> = Vec::new();
        for key in &conflicts {
            assert_eq!(key.perspective, audit, "emitted into the audit perspective");
            assert_eq!(key.predicate, conflict_pred);
            match &key.tuple[..] {
                [Value::Id(subject), Value::Str(pred), Value::Id(winner), Value::Id(loser), Value::Int(tick)] =>
                {
                    assert_eq!(*subject, 37);
                    assert_eq!(pred, "node", "predicate travels as its canonical NAME (§9.2)");
                    assert_eq!(*winner, row.fid);
                    assert_ne!(*loser, row.fid);
                    assert_eq!(*tick, 3, "Tick column = the WINNER's tick (DEV-4)");
                    seen_losers.push(*loser);
                }
                other => panic!("conflict/5 tuple shape: {other:?}"),
            }
        }
        seen_losers.dedup();
        assert_eq!(seen_losers.len(), 2, "one key per DISTINCT loser fact");
    }

    /// X5: the E-FUNC-001 intra-batch write gate — two Node groups, same
    /// subject, different node_type, ONE batch → whole batch aborts
    /// pre-commit, store byte-identical; identical-tuple re-assert in one
    /// batch is idempotent (NOT a firing).
    #[test]
    fn e_func_001_intra_batch_double_assert_aborts_whole_batch() {
        let fs = fixture_store();
        let s = fs.snapshot();
        let sha_before = fs.canonical_state_sha(&s);
        let count_before =
            collect(fs.sorted_run(&s, base_id(&fs, "node"), PERSPECTIVE_MAIN, SortOrder::Forward))
                .len();
        // A good group FIRST — the WHOLE batch must abort, not just the pair.
        let err = fs
            .assert_batch(batch(
                &fs,
                vec![
                    node_group(&fs, 900, "FUNCTION", &[]),
                    node_group(&fs, 901, "TYPE_ONE", &[]),
                    node_group(&fs, 901, "TYPE_TWO", &[]),
                ],
            ))
            .unwrap_err();
        assert_eq!(err.code, "E-FUNC-001", "{}", err.detail);
        let s = fs.snapshot();
        assert_eq!(
            sha_before,
            fs.canonical_state_sha(&s),
            "aborted batch leaves the store byte-identical"
        );
        assert_eq!(
            collect(fs.sorted_run(&s, base_id(&fs, "node"), PERSPECTIVE_MAIN, SortOrder::Forward))
                .len(),
            count_before,
            "no partial write"
        );
        // Identical tuple twice in one batch: idempotent, no error.
        fs.assert_batch(batch(
            &fs,
            vec![
                node_group(&fs, 902, "FUNCTION", &[]),
                node_group(&fs, 902, "FUNCTION", &[]),
            ],
        ))
        .expect("identical re-assert is not a firing");
    }

    /// X7 (E9): supersession interplay, both directions — and resolution
    /// itself never writes (sha byte-identical across resolve calls).
    #[test]
    fn resolve_supersession_interplay_both_directions() {
        let fs = LsmFactStore::ephemeral(2);
        assert_typed(&fs, SEEDED_PRIORITY_HIGH, 1, 38, "GLOBAL_DEFINITION");
        assert_typed(&fs, SEEDED_PRIORITY_LOW, 1, 38, "EXTERNAL_FUNCTION");
        let s = fs.snapshot();
        let sha_before = fs.canonical_state_sha(&s);
        let (row, conflicts) = resolve(&fs, &s, "node", 38).expect("live");
        assert_eq!(winner_type(&row), "GLOBAL_DEFINITION");
        assert_eq!(conflicts.len(), 1);
        // Resolution reads, never writes: sha unchanged.
        assert_eq!(sha_before, fs.canonical_state_sha(&s));
        // Direction 1: supersede the LOSER's assertions → single-fact subject,
        // no conflict emitted.
        fs.supersede(scope_all(&fs, SEEDED_PRIORITY_LOW), 10)
            .expect("supersede loser");
        let s = fs.snapshot();
        let (row, conflicts) = resolve(&fs, &s, "node", 38).expect("winner lives");
        assert_eq!(winner_type(&row), "GLOBAL_DEFINITION");
        assert!(conflicts.is_empty(), "single live fact → no conflict");
        // Direction 2 (fresh store): supersede the WINNER's assertions → the
        // former loser is now the sole winning fact.
        let fs = LsmFactStore::ephemeral(2);
        assert_typed(&fs, SEEDED_PRIORITY_HIGH, 1, 38, "GLOBAL_DEFINITION");
        assert_typed(&fs, SEEDED_PRIORITY_LOW, 1, 38, "EXTERNAL_FUNCTION");
        fs.supersede(scope_all(&fs, SEEDED_PRIORITY_HIGH), 10)
            .expect("supersede winner");
        let s = fs.snapshot();
        let (row, conflicts) = resolve(&fs, &s, "node", 38).expect("former loser lives");
        assert_eq!(winner_type(&row), "EXTERNAL_FUNCTION");
        assert!(conflicts.is_empty());
        // Superseding BOTH → no live fact at all.
        fs.supersede(scope_all(&fs, SEEDED_PRIORITY_LOW), 11)
            .expect("supersede the rest");
        let s = fs.snapshot();
        assert!(resolve(&fs, &s, "node", 38).is_none(), "0 candidates → None");
    }

    /// E10 (X9 divergence honesty): winner == storage winner is a MEASURED
    /// real-base property, not a theorem — a LOWER-tick record written LATER
    /// splits the two: resolve_functional picks max tick, get_node_at picks
    /// the newest segment. Legacy physics unchanged until P6.
    #[test]
    fn resolve_divergence_from_get_node_at_pinned() {
        let fs = LsmFactStore::ephemeral(2);
        fs.commit_legacy(
            vec![node_rec(
                39,
                "HIGH_TICK_TYPE",
                "n",
                "a.js",
                &meta_json(Some("alice"), Some(5u64.into())),
            )],
            vec![],
            &[],
        );
        fs.commit_legacy(
            vec![node_rec(
                39,
                "LOW_TICK_TYPE",
                "n",
                "a.js",
                &meta_json(Some("bob"), Some(3u64.into())),
            )],
            vec![],
            &[],
        );
        let s = fs.snapshot();
        let (row, conflicts) = resolve(&fs, &s, "node", 39).expect("two candidates");
        assert_eq!(winner_type(&row), "HIGH_TICK_TYPE", "resolve: max tick");
        assert_eq!(conflicts.len(), 1);
        let pinned = fs.read_snapshot_of(&s);
        let store = fs.store_read();
        let storage_winner = store.get_node_at(&pinned, 39).expect("record exists");
        assert_eq!(
            storage_winner.node_type, "LOW_TICK_TYPE",
            "get_node_at: newest segment — the documented P5-vs-legacy divergence"
        );
    }

    /// Perspective + absent-subject hygiene: non-main perspective → Ok(None)
    /// (exact-match empty answer); unknown subject → Ok(None).
    #[test]
    fn resolve_perspective_and_absent_subject_are_none() {
        let fs = fixture_store();
        let other = fs.intern_perspective("other");
        let s = fs.snapshot();
        assert!(fs
            .resolve_functional(&s, base_id(&fs, "node"), other, 11)
            .expect("typed path")
            .is_none());
        assert!(resolve(&fs, &s, "node", 0xdead_0000_0001).is_none());
    }

    /// X8 (E8/E8a at the facts read level — the C3-class gate): two v3
    /// records, same (id, author, tick), DIFFERENT node_type, two commits →
    /// both project as distinct live assertions, FullMerge keeps both, and
    /// the canonical sha is byte-identical across compaction.
    #[test]
    fn fold_key_c3_same_aid_identity_different_value_survives_compaction() {
        use crate::derive::tag::CountTag;
        use crate::storage_v2::types::COUNTTAG_SEMIRING_ID;
        let fs = LsmFactStore::ephemeral(2);
        let tagged = |ty: &str, weight: i64| {
            let rec = node_rec(41, ty, "", "c3/p5.rofl", &meta_json(Some("alice"), Some(2u64.into())));
            let fields = DerivedFields {
                provenance: ProvenanceV2 { rule_ast_hash: 0, generation: 2 },
                tag: TagV2 {
                    semiring_id: COUNTTAG_SEMIRING_ID,
                    bytes: CountTag(weight).to_le_bytes(),
                },
                tx_created: 0,
                tx_invalidated: TX_OPEN,
            };
            (rec, fields)
        };
        fs.commit_derived_tagged(vec![tagged("GLOBAL_DEFINITION", 5)], vec![]);
        fs.commit_derived_tagged(vec![tagged("EXTERNAL_FUNCTION", 3)], vec![]);
        let check = |fs: &LsmFactStore, label: &str| {
            let s = fs.snapshot();
            let rows: Vec<FactRow> = fs
                .live_filter(
                    &s,
                    Box::new(
                        collect(fs.sorted_run(
                            &s,
                            base_id(fs, "node"),
                            PERSPECTIVE_MAIN,
                            SortOrder::Forward,
                        ))
                        .into_iter(),
                    ),
                )
                .collect();
            assert_eq!(rows.len(), 2, "{label}: two distinct facts (two fids)");
            let mut weights: Vec<(String, i64)> = rows
                .iter()
                .map(|r| {
                    assert_eq!(r.assertions.len(), 1, "{label}: one assertion each");
                    (
                        winner_type(r),
                        CountTag::from_le_bytes(&r.assertions[0].tag.bytes)
                            .expect("count tag survives")
                            .0,
                    )
                })
                .collect();
            weights.sort();
            assert_eq!(
                weights,
                vec![
                    ("EXTERNAL_FUNCTION".to_string(), 3),
                    ("GLOBAL_DEFINITION".to_string(), 5)
                ],
                "{label}: separate per-aid Count weights — never ⊕-folded across aids"
            );
            fs.canonical_state_sha(&s)
        };
        let sha_before = check(&fs, "pre-compaction");
        fs.compact(None, CompactionTier::FullMerge).expect("full merge");
        let sha_after = check(&fs, "post-compaction");
        assert_eq!(sha_before, sha_after, "C3: sha is physics-invariant");
        // And the resolver arbitrates the two aids (same author+tick → min fid).
        let s = fs.snapshot();
        let (_, conflicts) = resolve(&fs, &s, "node", 41).expect("two live facts");
        assert_eq!(conflicts.len(), 1);
    }
}
