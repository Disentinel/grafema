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
