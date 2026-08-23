//! The converted store's manifest schema (P6 stage 1, rofl-fact-model.md §3.1 /
//! §10.3; ledger round-012-pre F3/Q2).
//!
//! `rofl_manifest.json` is the SINGLE-version manifest of the converted
//! per-predicate store, written atomically LAST (temp + rename). It is the first
//! ever PERSISTENCE of the predicate catalog («каталог живёт в манифесте …
//! версионируется вместе с ним», §3.1) — this serde schema is therefore a format
//! commitment, version-tagged by [`FORMAT_TAG`] so stage 2 can evolve it.
//!
//! Determinism (round-012-pre Q5): every collection is emitted in canonical
//! order (author/perspective tables in shortlex name order with id = position;
//! catalog in id order where ids ARE the shortlex ranks; segment descriptors in
//! (predicate, direction, shard) order); NO wall-clock field exists anywhere in
//! the schema (the `Manifest::create` `current_timestamp()` precedent is
//! forbidden on this path).

use std::path::Path;

use serde::{Deserialize, Serialize};

/// The version tag of the converted-store format (round-012-pre Q2).
pub const FORMAT_TAG: &str = "rofl-facts-v1";

/// One persisted predicate declaration (§3.1 fields + the reader-facing `kind`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeclJson {
    /// Interned predicate id — the position of `name` in the canonical shortlex
    /// order of the full vocabulary (round-012-pre Q5: assigned AFTER collection).
    pub id: u32,
    /// Canonical predicate name (§9.2: canonical artifacts use NAMES).
    pub name: String,
    /// Reader-facing provenance class: `core` (sid/type/name/file) | `edge`
    /// (edge_type-as-predicate) | `meta` (metadata-key predicate) | `retyped`
    /// (§10.3 step 4 Adjacency) | `span` (A″ composite) | `conflict`.
    pub kind: String,
    /// Tuple arity.
    pub arity: u8,
    /// Column NAMES, one per arity position, in tuple order. Without this a
    /// reader holding `span/5` sees five untyped Ints and cannot tell `column`
    /// from `endLine`; the meaning would live only in converter source.
    pub columns: Vec<String>,
    /// What column 0 (the subject) ranges over: `node` (a v2 node id), `edge`
    /// (a computed edge EID, see [`SchemesJson::eid`]), `node|edge` (a metadata
    /// predicate carrying both, discriminated only by which universe the id is
    /// in), or `pair` (Adjacency: columns 0 and 1 are both node ids).
    pub subject_universe: String,
    /// §3.1 strategy name: `Adjacency` | `Attribute` | `Composite` | `Nary`.
    pub strategy: String,
    /// §2.3: `Functional` | `MultiValued`.
    pub cardinality: String,
    /// §2.8: `Timeless` (all stage-1 predicates).
    pub temporal: String,
    /// Semiring id (BoolTag = 0 for every converted assertion).
    pub semiring: u16,
    /// Sort key of the forward run (column indexes).
    pub key_cols: Vec<u8>,
    /// Sort key of the reverse run, when declared (§6.3 normative matrix).
    pub reverse: Option<Vec<u8>>,
    /// §2.3 author priority, as canonical author NAMES (never interned ids).
    pub author_priority: Vec<String>,
    /// Exact live fact count (computed by the converter).
    pub live_facts: u64,
    /// Exact live assertion count (computed by the converter).
    pub live_asserts: u64,
    /// §3.4 per-column distinct counts — empty = the documented «not computed»
    /// sentinel (compaction-maintained stats are stage-2+).
    pub stats_distinct: Vec<u64>,
    /// §3.4 max fanout — 0 = not computed.
    pub stats_max_fanout: u64,
    /// §3.4 stats version — 0 = never computed by compaction.
    pub stats_updated_at_tx: u64,
}

/// One fact-segment descriptor (round-012-pre F1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SegmentJson {
    /// Owning predicate id.
    pub predicate: u32,
    /// Shard the run's rows were routed to (round-012-pre F2).
    pub shard: u16,
    /// `fwd` | `rev`.
    pub direction: String,
    /// Path relative to the store root.
    pub path: String,
    /// Physical row count (one row = one assertion).
    pub rows: u64,
    /// File length in bytes.
    pub bytes: u64,
    /// Zone map: canon bytes (hex, truncated to 48 bytes) of the run's leading
    /// key column in the FIRST row.
    pub zone_min_hex: String,
    /// Zone map: same for the LAST row.
    pub zone_max_hex: String,
    /// Bloom probe count, when the leading key column is Id-typed (§3.2: bloom
    /// over Id columns only).
    pub bloom_k: Option<u8>,
    /// Bloom bit count.
    pub bloom_m_bits: Option<u32>,
    /// sha256 of the segment file bytes.
    pub sha256: String,
}

/// Provenance of the conversion (round-012-pre F3). No timestamps.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProvenanceJson {
    /// The input database directory as given to the converter.
    pub input_path: String,
    /// Recursive sha256 of the input directory (path + length + content of
    /// every file, in sorted relative-path order).
    pub input_recursive_sha256: String,
    /// Total input bytes (`du -sb` equivalent).
    pub input_size_bytes: u64,
    /// The input's manifest version (current.json, preflight-verified against
    /// manifest_index.json).
    pub input_manifest_version: u64,
    /// Converter build provenance: the git SHA baked at compile time via
    /// `ROFL_CONVERT_GIT_SHA` (or `unbaked` for test builds) plus the crate
    /// version.
    pub converter: String,
}

/// The derivation rules a reader needs to reconstruct the store's identifiers
/// WITHOUT the converter source (round-012-pre Q2: the catalog must be
/// "complete enough to reconstruct the semantics"). Every field is a fixed
/// string constant of this format version — they are recorded, not computed, so
/// they cost nothing and cannot drift silently: if the converter ever changes a
/// scheme it must change the string, and an old store keeps its old string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SchemesJson {
    /// Canonical value encoding these tuples are hashed and sorted under.
    pub canon: String,
    /// How a fact id (fid) is derived from (perspective NAME, predicate NAME,
    /// tuple).
    pub fid: String,
    /// How an edge's subject id (EID) is derived. Variant A stores no
    /// `edge_of/3`, so edge-metadata subjects are ONLY reconstructible from
    /// this rule.
    pub eid: String,
    /// The §5.2 shard routing function.
    pub routing: String,
    /// The per-segment bloom probe function and parameter rule.
    pub bloom: String,
    /// How the u32 author component of [`RoflManifest::canonical_state_sha`]
    /// and of every physical row is derived from the author table.
    pub author_interning: String,
    /// The §9.1 state-digest formula, by name and version tag.
    pub state_sha: String,
}

impl SchemesJson {
    /// The rules of format version [`FORMAT_TAG`].
    pub fn v1() -> Self {
        Self {
            canon: "canon-v1 (crate::derive::canon::canon_bytes; tag byte then \
                    big-endian payload for Id/Int/Float, LEB128 length-prefixed bytes \
                    for Str/BigInt/Term; Str order is shortlex = LEB128(len) then bytes)"
                .to_string(),
            fid: "fid = LE-u128 of the first 16 bytes of \
                  BLAKE3(\"ROFL-FID-canon-v1\\n\" || canon(perspective NAME) || \
                  canon(predicate NAME) || varint(arity) || canon(col) for each column)"
                .to_string(),
            eid: "edge subject (EID) = fid(\"main\", <EDGE_TYPE predicate name>, \
                  [Id(src), Id(dst)]) — the §6.2 variant-A decomposition stores no \
                  edge_of/3, so an edge-metadata subject is reconstructible ONLY by \
                  recomputing this fid over the edge's own adjacency tuple"
                .to_string(),
            routing: "shard = (LE-u64 of the first 8 bytes of \
                      BLAKE3(canon(row[key_cols[0]]))) % shard_count"
                .to_string(),
            bloom: "built only when EVERY row's leading key column is Id-typed; \
                    k = 2, m_bits = clamp(next_power_of_two(rows * 10), 64, 1<<26); \
                    probes are (id >> 64) % m_bits and (id as u64) % m_bits"
                .to_string(),
            author_interning: "shortlex-rank: the u32 author component is the \
                               position of the author NAME in the shortlex-sorted \
                               `authors` table of THIS manifest. It is invariant to \
                               interning order but is NOT injective over names \
                               across stores — a store whose author set sorts to a \
                               different table assigns different ranks, and two \
                               different author sets that sort to the same ranks are \
                               indistinguishable in canonical_state_sha. See \
                               run-migration/OWNER-RULINGS.md open question OQ-C3-1."
                .to_string(),
            state_sha: "ROFL-STATE-v1 (design doc §9.1): BLAKE3(\"ROFL-STATE-v1\\n\" || \
                        varint(max tick) || for each live fact in §9.2 canonical order \
                        (perspective NAME, predicate NAME, tuple canon bytes): \
                        fact-key canon bytes || varint(|assertions|) || for each \
                        assertion LE-u32(author rank) || LE-u64(tick) || \
                        LE-u16(semiring) || varint(|tag|) || tag)"
                .to_string(),
        }
    }
}

/// The single-version manifest of a converted store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoflManifest {
    /// [`FORMAT_TAG`].
    pub format: String,
    /// §5.2: routing modulus, fixed at creation (= the input's shard_count).
    pub shard_count: u16,
    /// Perspective table in canonical shortlex order; id = position.
    pub perspectives: Vec<String>,
    /// Author table in canonical shortlex order; id = position.
    pub authors: Vec<String>,
    /// The identifier-derivation rules of this format version.
    pub schemes: SchemesJson,
    /// The full persisted catalog, in id (= shortlex rank) order.
    pub catalog: Vec<DeclJson>,
    /// Segment descriptors in (predicate, direction fwd-then-rev, shard) order.
    pub segments: Vec<SegmentJson>,
    /// Conversion provenance.
    pub provenance: ProvenanceJson,
    /// §10.1 verdict, recorded EXPLICITLY: every converted fact is asserted in
    /// perspective `main`; `audit` carries only the converter's conflict/5.
    pub perspective_ruling: String,
    /// §9.1 canonical state sha of the converted base (hex BLAKE3), computed by
    /// the converter's own reader over the written segments.
    pub canonical_state_sha: String,
}

impl RoflManifest {
    /// Serialize deterministically (struct-order fields, ordered collections).
    pub fn to_json(&self) -> String {
        let mut s = serde_json::to_string_pretty(self).expect("manifest serializes");
        s.push('\n');
        s
    }

    /// Atomic write: temp file + rename (round-012-pre F3 «atomic-last»).
    pub fn write_atomic(&self, root: &Path) -> std::io::Result<()> {
        let tmp = root.join("rofl_manifest.json.tmp");
        let dst = root.join("rofl_manifest.json");
        std::fs::write(&tmp, self.to_json())?;
        std::fs::rename(&tmp, &dst)
    }

    /// Read a manifest back, validating the format tag.
    pub fn read(root: &Path) -> Result<Self, String> {
        let path = root.join("rofl_manifest.json");
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let m: RoflManifest =
            serde_json::from_str(&text).map_err(|e| format!("malformed rofl_manifest.json: {e}"))?;
        if m.format != FORMAT_TAG {
            return Err(format!(
                "format tag mismatch: expected {FORMAT_TAG}, found {}",
                m.format
            ));
        }
        Ok(m)
    }
}
