//! The ROFL FactStore seam (rofl-fact-model.md §7.2/§7.3) — P2.
//!
//! P2 scope (§10.4 row P2, verbatim): «FactStore-трейт (§7.2) + Capabilities (§7.3)
//! поверх СЕГОДНЯШНЕГО own-LSM, без смены формата» — the seam on which read
//! equivalence can be proven while no second backend exists. This module holds the
//! BACKEND-NEUTRAL surface: the §2.2 fact/assertion/row types, the §7.2 trait, the
//! §7.3 capability vector, the §5.5 supersede-scope shape, and the error taxonomy.
//! The own-LSM adapter lives in [`lsm`]; per §8's layering, NOTHING in this file may
//! reference the physical store layer (rule 1, proxied by a mechanical import-hygiene
//! test below until the `rfdb-facts` crate split — ledger round-007-pre C17).
//!
//! Perspective discipline (§5.4a): the perspective is a parameter of EVERY read
//! primitive; [`Snapshot`] NEVER carries one (level 1 — type); [`PerspectiveId`]'s
//! field is private so no code outside `facts` can construct one by literal or
//! default (level 3, plus the mechanical grep test below). Reading a perspective
//! with no facts returns an EMPTY run — exact-match semantics, a valid empty answer,
//! not an error.
//!
//! Error envelope (ledger round-007-pre C7): §7.2's literal signatures return bare
//! iterators, but the P2 contract requires every absent-capability / phase-deferred
//! operation to be a TYPED `E-CAP-001`-family rejection — no panic, no silent empty
//! run (I5). `sorted_run` / `prefix_scan` / `resolve_functional` therefore wrap
//! their §7.2 payload in `Result<_, FactStoreError>`; the payload shapes (FactRow —
//! THE read unit — yielding iterators) are §7.2-verbatim.

pub mod convert;
pub mod lsm;

#[cfg(test)]
mod differential;

use std::any::Any;
use std::collections::HashMap;

use smallvec::SmallVec;

use crate::datalog::Value;
use crate::derive::canon::{canon_bytes, push_varint, CanonError, CANON_VERSION};
use crate::derive::catalog::{
    AuthorId, CatalogError, CatalogPredicateId, PredicateCatalog, PredicateDecl, PredicateStats,
};
// TagV2/TX_OPEN are imported through their §8 DESTINATION (`derive::tag` re-exports
// them; the tag module moves into the `rfdb-facts` crate at the split) — ledger
// round-007-pre C8. The physical store layer is never named here.
pub use crate::derive::tag::{TagV2, TX_OPEN};

// ── Perspectives (§5.4a) ───────────────────────────────────────────

/// An interned perspective identifier (§2.2: `u32`, interned in the catalog).
///
/// The field is PRIVATE by design: §5.4a level 3 forbids constructing a
/// `PerspectiveId` by literal or default outside the facts module — here that is a
/// compile error, not just the mechanical grep gate. Obtain one via
/// [`PERSPECTIVE_MAIN`] or a store's perspective interner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PerspectiveId(u32);

/// The canonical name of the pre-interned main perspective (§10.1: perspective is
/// not recoverable from today's records — ALL converted/projected facts live here).
pub const PERSPECTIVE_MAIN_NAME: &str = "main";

/// The pre-interned `main` perspective: id 0 in every [`PerspectiveTable`].
pub const PERSPECTIVE_MAIN: PerspectiveId = PerspectiveId(0);

/// Name ⇄ id interner for perspectives. `"main"` is always id 0. Canonical
/// artifacts (fid, state sha) use the NAME, never the interned id (§9.2).
#[derive(Debug, Clone)]
pub struct PerspectiveTable {
    names: Vec<String>,
    ids: HashMap<String, PerspectiveId>,
}

impl PerspectiveTable {
    /// A table with exactly `main` pre-interned at id 0.
    pub fn new() -> Self {
        let mut t = Self {
            names: Vec::new(),
            ids: HashMap::new(),
        };
        t.intern(PERSPECTIVE_MAIN_NAME);
        t
    }

    /// Intern `name`, returning its stable id within this table.
    pub fn intern(&mut self, name: &str) -> PerspectiveId {
        if let Some(&id) = self.ids.get(name) {
            return id;
        }
        let id = PerspectiveId(u32::try_from(self.names.len()).expect("≤ u32 perspectives"));
        self.names.push(name.to_string());
        self.ids.insert(name.to_string(), id);
        id
    }

    /// The canonical name of `id`, if interned in this table.
    pub fn name(&self, id: PerspectiveId) -> Option<&str> {
        self.names.get(id.0 as usize).map(String::as_str)
    }
}

impl Default for PerspectiveTable {
    fn default() -> Self {
        Self::new()
    }
}

// ── Fact / assertion / row (§2.2, normative shapes) ────────────────

/// A logical fact key (§2.2): identity IS content; no duplicates by construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactKey {
    /// Interned perspective (canonical artifacts use its NAME, §9.2).
    pub perspective: PerspectiveId,
    /// Catalog-interned predicate (canonical artifacts use its NAME, §9.2).
    pub predicate: CatalogPredicateId,
    /// N-ary tuple; there is NO arity lock at this level (§2.2).
    pub tuple: Box<[Value]>,
}

/// One assertion of a fact by one author at one tick (§2.2). NOT self-describing:
/// carries no tuple — it always travels inside a [`FactRow`] (rev-2.0 review
/// blocker: an `Assertion`-yielding iterator is unimplementable, `fid` is a one-way
/// hash).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assertion {
    /// The owning fact's content hash (§2.1).
    pub fid: u128,
    /// Interned author. Projected from record metadata `_source` today (§10.1).
    pub author: AuthorId,
    /// Projected from record metadata `_generation` today (§10.1).
    pub tick: u64,
    /// Semiring tag. Projected rows are Bool (§2.2 MEASURED: prod segments carry no
    /// tag columns).
    pub tag: TagV2,
    /// Creation tx. 0 for projected rows (pre-assertion-physics, P4).
    pub tx_created: u64,
    /// Invalidation CACHE (§2.4: never authoritative for liveness; `TX_OPEN` means
    /// «nothing» — liveness is the absence of a live `supersedes(_, aid)` fact).
    pub tx_invalidated: u64,
}

/// THE read unit (§2.2): the decoded tuple ALWAYS travels with its live assertions.
/// Every read iterator yields `FactRow`, never a bare [`Assertion`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactRow {
    /// Decoded perspective + predicate + tuple.
    pub key: FactKey,
    /// Content hash of `key` (§2.1).
    pub fid: u128,
    /// All live assertions of this fact in the read snapshot.
    pub assertions: SmallVec<[Assertion; 2]>,
}

impl FactRow {
    /// The decoded tuple (§2.2's reverse primitive at row level).
    pub fn tuple(&self) -> &[Value] {
        &self.key.tuple
    }
}

// ── Read order / maintenance shapes ────────────────────────────────

/// Which declared run of a predicate a read follows (§3.1): `Forward` = the
/// declared `key_cols` run, `Reverse` = the declared `reverse` run. Requesting
/// `Reverse` on a predicate that declares `reverse: None` is a typed
/// `E-CAP-001`-family error, never a silent empty run (I5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortOrder {
    /// The predicate's declared `key_cols` run.
    Forward,
    /// The predicate's declared `reverse` run.
    Reverse,
}

/// Compaction tier at the facts level (ledger round-007-pre C11: §7.2 names the
/// type; the store layer has only a numeric config — the adapter maps these).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionTier {
    /// The store's default size-tiered policy.
    Tiered,
    /// Fold everything into one run per shard (the bulk-load barrier policy).
    FullMerge,
}

/// The explicit retraction area of a supersede (§5.5) — declared, not inferred
/// from a data field. Consumed only by the `E-CAP-001` rejection until P4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupersedeScope {
    /// Whose assertions are superseded.
    pub author: AuthorId,
    /// In which perspective.
    pub perspective: PerspectiveId,
    /// `None` = all predicates of the author.
    pub predicate: Option<CatalogPredicateId>,
    /// Which subjects.
    pub subject_set: SubjectSet,
}

/// Subject selection of a [`SupersedeScope`] (§5.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubjectSet {
    /// An explicit subject list.
    Explicit(Vec<u128>),
    /// Subjects matching an attribute predicate value set (`ByAttr{file, changed}`
    /// reproduces today's reanalysis contract exactly, §5.5).
    ByAttr {
        /// The attribute predicate.
        pred: CatalogPredicateId,
        /// The matching values.
        values: Vec<Value>,
    },
    /// Every subject of the author.
    All,
}

// ── Write batch (P2: record-shaped groups, ledger round-007-pre C12) ──

/// One fact inside an [`AssertBatch`] group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupFact {
    /// The asserted predicate (base vocabulary only in P2).
    pub predicate: CatalogPredicateId,
    /// The asserted tuple.
    pub tuple: Box<[Value]>,
}

/// A record-shaped fact group (P2 write granularity). §2.1 verbatim: «половину
/// записи сегодня заменить нельзя — после миграции можно» — so P2 accepts ONLY
/// whole-record shapes; sub-record granularity is a typed `E-CAP-001`
/// (`assertion-granularity`) rejection, never emulated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FactGroup {
    /// One node record: exactly one `node/2` fact plus optional `attr/3` facts for
    /// the SAME subject — assembled into one node record.
    Node {
        /// The group's facts (`node/2` + `attr/3`).
        facts: Vec<GroupFact>,
    },
    /// One edge record: exactly one `edge/3` fact.
    Edge {
        /// The `edge/3` fact.
        fact: GroupFact,
    },
    /// One `supersedes/2` fact (P4, ledger round-010-pre D12): tuple
    /// `[Id(aid_new), Id(aid_old)]` over the reserved supersedes predicate.
    /// Subject to the E-SUP-001 store boundary: the victim `aid_old` must
    /// resolve to a known assertion in the pre-commit snapshot and the batch
    /// tick must be STRICTLY greater than the victim's tick (§2.4 — this is
    /// what makes supersedes cycles unconstructible).
    Supersedes {
        /// The `supersedes/2` fact.
        fact: GroupFact,
    },
}

/// A write batch (§7.2). `author`/`tick` are stamped onto every asserted fact —
/// the exact inverse of the read projection's `_source`/`_generation` mapping
/// (§10.1), so legacy-write→fact-read and fact-write→legacy-read commute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssertBatch {
    /// Target perspective. P2: must be [`PERSPECTIVE_MAIN`] (§10.1: perspective is
    /// unrepresentable in today's record format) — else `E-CAP-001`.
    pub perspective: PerspectiveId,
    /// The asserting author (interned via the store).
    pub author: AuthorId,
    /// The asserting tick.
    pub tick: u64,
    /// Record-shaped fact groups.
    pub groups: Vec<FactGroup>,
}

/// The published result of a committed write (§7.2): wraps the store's publish
/// point (manifest version) so readers can pin at-or-after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommitToken {
    /// The published version after this commit.
    pub version: u64,
}

// ── Capabilities (§7.3, verbatim) ──────────────────────────────────

/// Backend capability negotiation (§7.3, the eight flags verbatim). A plan that
/// requires an absent capability is rejected `E-CAP-001` — never silently
/// degraded (I5). A flag describes NATIVE physics: a backend may still SERVE
/// sorted runs by materialize+sort while declaring `sorted_runs: false` — that is
/// §7.1's honesty requirement, not a contradiction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// Runs come out in declared order WITHOUT re-sorting.
    pub sorted_runs: bool,
    /// Keyed prefix probes (not bloom-gate + linear scan).
    pub prefix_scan: bool,
    /// ⊕-fold of tags at compaction without read-modify-write.
    pub merge_operator: bool,
    /// Build a run outside the LSM and ingest it.
    pub bulk_ingest: bool,
    /// Version-pinned snapshot reads.
    pub snapshot_isolation: bool,
    /// Historical tick queries (§2.8).
    pub as_of_tick: bool,
    /// On-disk compression.
    pub compression: bool,
    /// Online routing change.
    pub reshard: bool,
}

// ── Errors ─────────────────────────────────────────────────────────

/// A typed FactStore rejection. Codes are drawn ONLY from the doc's taxonomy
/// (P2 budget): `E-VAL-001`/`E-VAL-002` (canonical boundary, inherited from the
/// P1 canon layer at the `assert_batch` write boundary — round-005-pre H4),
/// `E-CAT-001` (catalog), `E-CAP-001` (absent capability / phase-deferred
/// operation — round-007-pre C7/C10/C12), and since P5 (ledger round-011-pre
/// E6/E7): `E-FUNC-001` (§2.3 — ONE author asserting TWO distinct values of a
/// Functional predicate about ONE subject in ONE batch; pre-commit whole-batch
/// abort, E-MAT-002/E-EXEC-001 class) and `E-FUNC-002` (a NEW code under this
/// convention — `resolve_functional` called on a MultiValued predicate: a
/// caller contract violation, never a panic, never a silent `None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactStoreError {
    /// The stable taxonomy code (load-bearing, I5).
    pub code: &'static str,
    /// Human-oriented hint; for `E-CAP-001` it NAMES the missing capability.
    pub detail: String,
}

impl FactStoreError {
    /// An `E-CAP-001` rejection naming the missing `capability`.
    pub fn cap(capability: &str, detail: impl std::fmt::Display) -> Self {
        Self {
            code: "E-CAP-001",
            detail: format!("missing capability '{capability}': {detail}"),
        }
    }
}

impl std::fmt::Display for FactStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for FactStoreError {}

impl From<CanonError> for FactStoreError {
    fn from(e: CanonError) -> Self {
        Self {
            code: e.code,
            detail: e.detail,
        }
    }
}

impl From<CatalogError> for FactStoreError {
    fn from(e: CatalogError) -> Self {
        Self {
            code: e.code,
            detail: e.detail,
        }
    }
}

/// Result alias for FactStore operations.
pub type FactResult<T> = Result<T, FactStoreError>;

// ── Snapshot ───────────────────────────────────────────────────────

/// An opaque, version-pinned read snapshot (§7.2). Carries NO perspective
/// (§5.4a level 1: the perspective is a parameter of every read call, because one
/// query legitimately reads several perspectives). The payload is backend-owned;
/// only the issuing store can interpret it, and only the facts layer can
/// construct one.
pub struct Snapshot {
    payload: Box<dyn Any + Send + Sync>,
}

impl Snapshot {
    /// Wrap a backend payload. Constructor is module-private on purpose: a
    /// snapshot is only ever minted by a [`FactStore`] impl.
    pub(crate) fn new(payload: Box<dyn Any + Send + Sync>) -> Self {
        Self { payload }
    }

    /// Downcast the backend payload.
    pub(crate) fn payload_ref<T: 'static>(&self) -> Option<&T> {
        self.payload.downcast_ref::<T>()
    }
}

// ── Canonical identity (§2.1 / §9.2) ───────────────────────────────

/// Append the canonical byte encoding of a fact key to `out`:
/// `varint(|persp|) ⧺ persp ⧺ varint(|pred|) ⧺ pred ⧺ varint(arity) ⧺
/// canon_bytes(tuple…)` — the canonical NAME strings, never interned u32 ids
/// (§9.2: interned ids depend on declaration order and process; hashing them is
/// forbidden). Rejects non-canonical tuple values (`E-VAL-001`/`E-VAL-002`).
pub fn fact_key_canon_bytes(
    perspective_name: &str,
    predicate_name: &str,
    tuple: &[Value],
    out: &mut Vec<u8>,
) -> Result<(), CanonError> {
    push_varint(out, perspective_name.len() as u64);
    out.extend_from_slice(perspective_name.as_bytes());
    push_varint(out, predicate_name.len() as u64);
    out.extend_from_slice(predicate_name.as_bytes());
    push_varint(out, tuple.len() as u64);
    for v in tuple {
        canon_bytes(v, out)?;
    }
    Ok(())
}

/// `fid = BLAKE3(canon(perspective, predicate, tuple))[0..16] LE` (§2.1), with the
/// canon-version prelude so a future canon-v2 can never silently alias canon-v1
/// hashes. The exact byte layout is pinned by a golden test vector.
pub fn fid(
    perspective_name: &str,
    predicate_name: &str,
    tuple: &[Value],
) -> Result<u128, CanonError> {
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(b"ROFL-FID-");
    input.extend_from_slice(CANON_VERSION.as_bytes());
    input.push(b'\n');
    fact_key_canon_bytes(perspective_name, predicate_name, tuple, &mut input)?;
    let hash = blake3::hash(&input);
    let mut first16 = [0u8; 16];
    first16.copy_from_slice(&hash.as_bytes()[..16]);
    Ok(u128::from_le_bytes(first16))
}

/// `aid = BLAKE3(fid ‖ varint(|author_name|) ‖ author_name ‖ tick_u64)` (§2.1),
/// truncated to u128 LE like `fid`.
///
/// P4 canonicalization (ledger round-010-pre D7, resolving round-007-pre C9):
/// the aid hashes the canonical author NAME, not the runtime-interned u32 —
/// supersedes fact tuples HASH aids into fids (canonical artifacts), and §9.2
/// forbids interned ids in canonical artifacts (they depend on declaration
/// order and process; the cross-process sha gate would fail). The §2.2
/// `author_u32` form is the physical shorthand for the same identity.
pub fn aid(fid: u128, author_name: &str, tick: u64) -> u128 {
    let mut input = Vec::with_capacity(16 + 1 + author_name.len() + 8);
    input.extend_from_slice(&fid.to_le_bytes());
    push_varint(&mut input, author_name.len() as u64);
    input.extend_from_slice(author_name.as_bytes());
    input.extend_from_slice(&tick.to_le_bytes());
    let hash = blake3::hash(&input);
    let mut first16 = [0u8; 16];
    first16.copy_from_slice(&hash.as_bytes()[..16]);
    u128::from_le_bytes(first16)
}

// ── The trait (§7.2) ───────────────────────────────────────────────

/// A store of RELATIONS (§7.2): the unit is the predicate, not the key. To be
/// implemented by every backend. Read methods take the perspective EXPLICITLY
/// (§5.4a level 1); [`FactRow`] is the only read unit (§2.2); error envelope per
/// ledger round-007-pre C7.
pub trait FactStore: Sync {
    /// The predicate catalog (§3.1) — the ONE place a predicate gets physics.
    fn catalog(&self) -> &PredicateCatalog;

    /// Declare a predicate. Identical redeclaration is idempotent; any
    /// conflicting redeclaration is `E-CAT-001` (delegates to the P1 catalog).
    fn declare(&mut self, decl: PredicateDecl) -> FactResult<CatalogPredicateId>;

    /// The backend's §7.3 capability vector. Honest per §7.4 — flags describe
    /// native physics, not what the adapter can emulate.
    fn capabilities(&self) -> Capabilities;

    /// Capture a version-pinned snapshot. Carries NO perspective (§5.4a).
    fn snapshot(&self) -> Snapshot;

    /// The sorted run of a predicate in the given declared order — the merge-join
    /// path. Rows come out ascending in §9.2 canon order over the order's key
    /// columns (a P2-defined order, DISTINCT from the executor's exec order —
    /// P1 call C4: the two orders stay separate; differentials compare multisets).
    fn sorted_run<'a>(
        &'a self,
        s: &'a Snapshot,
        p: CatalogPredicateId,
        persp: PerspectiveId,
        o: SortOrder,
    ) -> FactResult<Box<dyn Iterator<Item = FactRow> + 'a>>;

    /// Prefix probe: all facts of the predicate whose sort key (in order `o`)
    /// starts with `prefix`. The ONE primitive generalizing today's four keyed
    /// reads (edges-from / edges-to / node-by-id / nodes-by-attr, §7.2).
    fn prefix_scan<'a>(
        &'a self,
        s: &'a Snapshot,
        p: CatalogPredicateId,
        persp: PerspectiveId,
        o: SortOrder,
        prefix: &[Value],
    ) -> FactResult<Box<dyn Iterator<Item = FactRow> + 'a>>;

    /// Point probe by fid. §8.3 stands: FORBIDDEN in the fixpoint hot loop —
    /// which is what makes a lazily-built per-snapshot index a contractual cost
    /// (round-007-pre C14).
    fn get_fact(&self, s: &Snapshot, fid: u128) -> Option<FactRow>;

    /// Reverse map fid → tuple (§2.2: BLAKE3 is one-way; reflection and
    /// derivation witnesses receive fids as VALUES and need this).
    fn tuple(&self, s: &Snapshot, fid: u128) -> Option<Box<[Value]>>;

    /// Liveness (§2.4, DEFINITIONAL): an assertion is live ⟺ there is no LIVE
    /// `supersedes(_, aid)` fact in the snapshot (the definition recurses over
    /// supersedes' own assertions and is well-founded by tick — E-SUP-001).
    /// `tx_invalidated != TX_OPEN` is a CACHE that may only CONFIRM death
    /// (rule 1): an assertion cache-marked dead with NO live `supersedes(_,
    /// aid)` fact in the same snapshot is CORRUPTION and aborts with a
    /// contractual panic carrying `E-SUP-001` (divergence arm, ledger
    /// round-010-pre D3) — never a silent pick of one truth. This primitive is
    /// the ONLY legal liveness authority on the read path (mechanical guard
    /// test) and carries the anti-join cost EXPLICITLY.
    fn live_filter<'a>(
        &'a self,
        s: &'a Snapshot,
        rows: Box<dyn Iterator<Item = FactRow> + 'a>,
    ) -> Box<dyn Iterator<Item = FactRow> + 'a>;

    /// Functional-conflict resolution (§2.3, REAL since P5 — OWNER-RULINGS
    /// R-1a, ledger round-011-pre).
    ///
    /// For a `Functional` predicate `p`, perspective `persp`, snapshot `s` and
    /// subject `S`: the candidate set is ALL LIVE assertions (§2.4 liveness —
    /// the same killed-aid set [`FactStore::live_filter`] uses) of ALL facts
    /// of `p` in `persp` whose c0 == `S`. Then:
    /// - 0 candidates → `Ok(None)`;
    /// - all live assertions on ONE fid (agreement) → `Ok(Some((row, [])))` —
    ///   NO conflict;
    /// - ≥2 distinct live fids → the winning ASSERTION is picked by the R-1a
    ///   order (deviates from doc §2.3's priority→tick→fid; recorded):
    ///   (i) max tick; (ii) the decl's `author_priority` table — optional,
    ///   empty = skip, undecided (any unlisted author / all one rank) = skip;
    ///   (iii) author canon-order — LESSER canonical author NAME in canon Str
    ///   order (shortlex, `cmp_len_prefixed`), NOT plain `str::cmp`;
    ///   (iv) min fid (numeric u128). Fid uniqueness makes the order TOTAL:
    ///   the read side always decides and never errors — the read-side
    ///   E-FUNC-001 arm is unreachable by construction (pinned by test).
    ///
    /// On EVERY multi-live resolution one `conflict/5` [`FactKey`] per LOSER
    /// fact is RETURNED (k live facts → k−1 keys): perspective `audit`,
    /// tuple `[Id(subject), Str(predicate_name), Id(winner_fid),
    /// Id(loser_fid), Int(winner_tick)]` — the predicate travels as its
    /// canonical NAME per §9.2. Emission is the return channel ONLY: the
    /// store stays monotone, the read path pure; durable audit-perspective
    /// materialization is converter/C7 policy (recorded deviation).
    ///
    /// Calling this on a `MultiValued` predicate is a caller contract
    /// violation: typed `E-FUNC-002`.
    fn resolve_functional(
        &self,
        s: &Snapshot,
        p: CatalogPredicateId,
        persp: PerspectiveId,
        subject: u128,
    ) -> FactResult<Option<(FactRow, Vec<FactKey>)>>;

    /// Assert a batch of record-shaped fact groups. THE inherited E-VAL-001/002
    /// enforcement point (round-005-pre H4): every tuple value is validated
    /// canonically, recursively through `Term`, BEFORE any commit; a violation
    /// aborts the WHOLE batch with the store unchanged.
    fn assert_batch(&self, b: AssertBatch) -> FactResult<CommitToken>;

    /// Supersede assertions in scope (§5.5, REAL since P4): enumerate the LIVE
    /// assertions whose author == `scope.author` within (perspective,
    /// predicate?, subject_set) and write one `supersedes(_, aid_old)` fact
    /// per victim through the facts commit path. Author scoping is ABSOLUTE
    /// (§4.2): «Чужие ассершны не трогаются никогда» — no scope can kill a
    /// foreign author's assertion. E-SUP-001 at the boundary: `at_tick` must
    /// be STRICTLY greater than every victim's tick, else the WHOLE operation
    /// aborts pre-commit with the store unchanged.
    /// `ByAttr { pred: attr, values: [Str(key), matched values…] }` is the P4
    /// base-five encoding of the doc's `ByAttr{file, changedFiles}` reanalysis
    /// contract (ledger round-010-pre D10).
    fn supersede(&self, scope: SupersedeScope, at_tick: u64) -> FactResult<CommitToken>;

    /// Enter bulk-load mode (deferred durability until the barrier).
    fn begin_bulk_load(&mut self) -> FactResult<()>;

    /// Exit bulk-load mode: flush, fold, durable barrier, restore strictness.
    fn end_bulk_load(&mut self) -> FactResult<()>;

    /// Compact. `p = None` = the whole store (delegated); `p = Some(_)` = per-
    /// predicate compaction, which today's segment vocabulary cannot express
    /// (exactly {nodes, edges}) — `E-CAP-001` (`per-predicate-compaction`).
    fn compact(&self, p: Option<CatalogPredicateId>, tier: CompactionTier) -> FactResult<()>;

    /// Planner statistics (§3.4). P2: base-five `live_facts`/`live_asserts`
    /// computed ONCE at the first `stats()` observation, from a snapshot taken
    /// at that moment (ledger C20 refining C13 — construction-time compute
    /// would observe the pre-commit empty state); `distinct`/`max_fanout` stay
    /// 0 with `updated_at_tx = 0` as the documented «not computed» sentinel —
    /// real maintenance is §10.4 P3 by name.
    fn stats(&self, p: CatalogPredicateId) -> &PredicateStats;

    /// §9.1: BLAKE3 of the LOGICAL live fact set in §9.2 canonical order — never
    /// physical bytes, so compaction / flush / shard count / segment order cannot
    /// move it. The strongest differential instrument P2 ships.
    ///
    /// Contract: `s` MUST have been minted by THIS store. Handing a foreign
    /// backend's snapshot is a programming error and MAY panic — unlike
    /// [`FactStore::get_fact`]/[`FactStore::tuple`], which answer `None` for an
    /// absent fact and cannot distinguish that from a foreign snapshot, a state
    /// sha has no honest degraded answer (returning anything would be a wrong
    /// hash presented as right).
    fn canonical_state_sha(&self, s: &Snapshot) -> [u8; 32];
}

// ── Mechanical hygiene gates (§8 rule proxies; CI runs no cargo, so these
//    tests ARE the gates, run by the phase checklist) ────────────────

#[cfg(test)]
mod hygiene_tests {
    /// §8 rule 1 proxy (round-007-pre C17): the backend-neutral surface must not
    /// name the physical store layer. `facts/mod.rs` (this file) referencing the
    /// store module would be exactly the «протечка раскладки в модель» rule 2
    /// mechanically tests for at crate level.
    #[test]
    fn facts_mod_references_no_storage_layer() {
        let src = include_str!("mod.rs");
        let needle = format!("storage{}v2", "_"); // avoid self-matching this test
        assert!(
            !src.contains(&needle),
            "facts/mod.rs must not reference the physical store layer (§8 rule 1)"
        );
    }

    /// P4 (§2.4 / ledger round-010-pre D15): live_filter is the ONLY legal
    /// liveness authority on the read path. The mechanical guard: outside
    /// `src/facts/` there exists NO consumer of the FactStore read surface at
    /// all — any reference to the `FactStore` trait or the `LsmFactStore`
    /// backend outside the facts module is an offender and is listed. (The
    /// single permitted foreign coupling is the `SortOrder` TYPE import in
    /// derive/{catalog,plan,exec} — a dispatch key, not a read path — and it
    /// does not contain the guarded tokens.) When the fixpoint engine moves
    /// onto this seam (P6/P7), its call sites must route liveness through
    /// live_filter and extend this guard's allowlist EXPLICITLY.
    #[test]
    fn no_fact_store_consumer_outside_facts() {
        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![src_root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("readable src dir") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    if path.file_name().is_some_and(|n| n == "facts") {
                        continue; // the facts module itself
                    }
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).expect("readable source");
                    let needle = format!("Fact{}", "Store"); // avoid self-matching
                    // CODE references only — doc comments may (and do) NAME the
                    // seam; they cannot read from it.
                    let in_code = text.lines().any(|line| {
                        let t = line.trim_start();
                        !t.starts_with("//") && t.contains(&needle)
                    });
                    if in_code {
                        offenders.push(path.display().to_string());
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "FactStore surface consumed outside src/facts/ — every read path must go \
             through live_filter (§2.4, ledger D15). Offenders: {offenders:?}"
        );
    }

    /// §5.4a level 3: no `PerspectiveId` constructed by literal or default
    /// outside `src/facts/`. Defense in depth: the field is private, so foreign
    /// construction is ALSO a compile error — this grep proves nobody added a
    /// constructor loophole either.
    #[test]
    fn no_perspective_id_literal_outside_facts() {
        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![src_root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("readable src dir") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    if path.file_name().is_some_and(|n| n == "facts") {
                        continue; // the facts module itself may construct ids
                    }
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).expect("readable source");
                    if text.contains("PerspectiveId(") || text.contains("PerspectiveId::default") {
                        offenders.push(path.display().to_string());
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "PerspectiveId constructed outside src/facts/ (§5.4a level 3): {offenders:?}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perspective_table_interns_main_at_zero() {
        let mut t = PerspectiveTable::new();
        assert_eq!(t.intern(PERSPECTIVE_MAIN_NAME), PERSPECTIVE_MAIN);
        assert_eq!(t.name(PERSPECTIVE_MAIN), Some(PERSPECTIVE_MAIN_NAME));
        let other = t.intern("other");
        assert_ne!(other, PERSPECTIVE_MAIN);
        assert_eq!(t.name(other), Some("other"));
        // Idempotent.
        assert_eq!(t.intern("other"), other);
    }

    /// Golden vector: pins the EXACT canon input layout of `fid` (§2.1) so it can
    /// never drift silently — prelude `"ROFL-FID-canon-v1\n"`, then
    /// varint-len-prefixed perspective and predicate NAMES, varint arity, then
    /// canon-v1 value bytes. Recomputing the layout by hand here (independent
    /// byte assembly) guards the helper; the hex constant guards cross-process /
    /// cross-version stability.
    #[test]
    fn fid_golden_vector_pins_canon_input_layout() {
        let tuple = [Value::Id(1), Value::Str("FUNCTION".to_string())];
        // Independent byte assembly (NOT via fact_key_canon_bytes).
        let mut expected_input: Vec<u8> = Vec::new();
        expected_input.extend_from_slice(b"ROFL-FID-canon-v1\n");
        expected_input.push(4); // varint len "main"
        expected_input.extend_from_slice(b"main");
        expected_input.push(4); // varint len "node"
        expected_input.extend_from_slice(b"node");
        expected_input.push(2); // varint arity
        expected_input.push(0x01); // canon tag Id
        expected_input.extend_from_slice(&1u128.to_be_bytes());
        expected_input.push(0x02); // canon tag Str
        expected_input.push(8); // varint len "FUNCTION"
        expected_input.extend_from_slice(b"FUNCTION");
        let expected_hash = blake3::hash(&expected_input);
        let mut first16 = [0u8; 16];
        first16.copy_from_slice(&expected_hash.as_bytes()[..16]);
        let expected = u128::from_le_bytes(first16);

        let got = fid("main", "node", &tuple).expect("canonical tuple");
        assert_eq!(got, expected, "fid layout drifted from the pinned assembly");

        // Cross-process / cross-version golden: the exact 16 LE bytes, pinned as
        // a literal so NO code path (not even the independent assembly above)
        // can drift them silently.
        const GOLDEN_FID_LE_HEX: &str = "b0093490018cd3e0b28033a96109a92f";
        let got_hex: String = got
            .to_le_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(got_hex, GOLDEN_FID_LE_HEX, "pinned fid bytes drifted");
    }

    #[test]
    fn fid_rejects_non_canonical_tuples_with_inner_code() {
        // BigInt fitting i64 → E-VAL-001.
        let bad = [Value::BigInt([1, 2, 3].into())];
        assert_eq!(fid("main", "node", &bad).unwrap_err().code, "E-VAL-001");
        // -0.0 → E-VAL-002.
        let bad = [Value::Float(-0.0)];
        assert_eq!(fid("main", "node", &bad).unwrap_err().code, "E-VAL-002");
    }

    /// P4 (ledger round-010-pre D7): the aid is keyed on the canonical author
    /// NAME — process-invariant, so supersedes tuples (which hash aids into
    /// fids) stay canonical artifacts under §9.2.
    #[test]
    fn aid_depends_on_all_three_components() {
        let f = 42u128;
        let base = aid(f, "analyzer", 7);
        assert_ne!(base, aid(f + 1, "analyzer", 7));
        assert_ne!(base, aid(f, "enricher", 7));
        assert_ne!(base, aid(f, "analyzer", 8));
        // Deterministic, and independent of any interner state.
        assert_eq!(base, aid(f, "analyzer", 7));
        // Length-prefixed name: no concatenation ambiguity with the tick bytes.
        assert_ne!(aid(f, "a", 0x62), aid(f, "ab", 0x62));
    }
}
