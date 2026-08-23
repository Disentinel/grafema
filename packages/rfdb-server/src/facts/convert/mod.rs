//! P6 STAGE 1 — the converter (rofl-fact-model.md §10.3; ledger round-012-pre).
//!
//! Re-homes a record-model (v2) RFDB base into the per-predicate fact layout:
//! the six §10.3 duties in order — (1) input strictly read-only with an
//! index-consistency preflight (the `rebuild_index` write hazard,
//! storage_v2/manifest.rs:945, is detected and ABORTED on, never triggered);
//! (2) §6.2 decomposition into the open predicate vocabulary (metadata keys as
//! predicates, edge_type-as-predicate, A″ span/5 collapse per round-012-pre Q6)
//! with every predicate declared through the P1 [`PredicateCatalog`];
//! (3) §10.1 assertion synthesis (author ← `_source`, tick ← `_generation`,
//! perspective = `main`, `$legacy`/0 with counters); (4) §10.3 step 4 retyping
//! of decimal-u128 string metadata into [`Value::Id`] under the three Adjacency
//! predicates; (5) Functional resolution under the R-1a order with DURABLE
//! `conflict/5` emission into perspective `audit` (losers stay LIVE —
//! round-012-pre Q10); (6) §9.1 canonical state sha + the four §9.4 metrics.
//!
//! Determinism (round-012-pre Q5): interned ids are assigned AFTER full
//! vocabulary collection in canonical shortlex name order; every output path
//! iterates sorted structures; no wall-clock reaches the output; enumeration is
//! manifest/snapshot-descriptor driven; the conversion is single-threaded.
//! The gate is two SEPARATE-PROCESS runs producing byte-identical output dirs.

pub mod manifest;
pub mod reader;
pub mod segment;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::datalog::{TermBlob, Value};
use crate::derive::canon::canon_bytes;
use crate::derive::catalog::{
    AuthorId, Cardinality, PhysStrategy, PredicateCatalog, PredicateDecl, PredicateStats,
    TemporalScope,
};
use crate::facts::lsm::{
    LsmFactStore, LEGACY_AUTHOR, PERSPECTIVE_AUDIT_NAME, SEEDED_PRIORITY_HIGH,
    SEEDED_PRIORITY_LOW, SUPERSEDES_NODE_TYPE,
};
use crate::facts::{fid, FactStore, PERSPECTIVE_MAIN, PERSPECTIVE_MAIN_NAME};
use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2, BOOLTAG_SEMIRING_ID};

use manifest::{DeclJson, ProvenanceJson, RoflManifest, SegmentJson, FORMAT_TAG};
use segment::{canon_str_cmp, write_segment, PhysRow, DIR_FWD, DIR_REV};

/// The author of durable conflict/5 assertions (round-012-pre S7).
pub const CONVERT_AUTHOR: &str = "$rofl-convert";
/// The §10.3 step-4 retyped predicates (Adjacency, decimal-u128 string → Id).
pub const RETYPED_PREDS: [&str; 3] = ["anchorCall", "handler_function_id", "source_node"];
/// The A″ span-collapse source keys, in span/5 column order (Q6).
pub const SPAN_KEYS: [&str; 4] = ["line", "column", "endLine", "endColumn"];
/// Metadata keys that are assertion fields, never facts (§6.2).
const RESERVED_META_KEYS: [&str; 2] = ["_source", "_generation"];
/// Column-authoritative keys whose blob copies are skipped (facts/lsm.rs
/// COLUMN_META_KEYS precedent, ledger round-008 R2; round-012-pre S5).
const COLUMN_META_KEYS: [&str; 3] = ["name", "file", "semantic_id"];
/// Core/reserved predicate names a metadata key may not silently collide with
/// (round-012-pre S6): such keys get the `$meta:` prefix.
const CORE_RESERVED: [&str; 7] = ["sid", "type", "name", "file", "span", "conflict", "supersedes"];
/// Collision-guard prefix (S6), stripped by the reader on reassembly.
pub const META_PREFIX: &str = "$meta:";
/// The predicate names of the §3.3 Functional set in the converted vocabulary
/// (round-012-pre Q7): the node_view four + sid; `__exported` is the measured
/// metadata carrier of `exported` (graph/engine_v2.rs).
pub const FUNCTIONAL_PREDS: [&str; 5] = ["type", "name", "file", "sid", "__exported"];

/// Perspective ids in the converted store: canonical shortlex order of
/// {"main", "audit"} puts `main` (len 4) before `audit` (len 5).
pub const PERSP_MAIN: u32 = 0;
/// The audit perspective (conflict/5 lives here).
pub const PERSP_AUDIT: u32 = 1;
/// The perspective table in canonical order.
pub const PERSP_NAMES: [&str; 2] = [PERSPECTIVE_MAIN_NAME, PERSPECTIVE_AUDIT_NAME];

// ── Errors ─────────────────────────────────────────────────────────

/// A typed converter rejection (stable codes, never a silent fallback).
#[derive(Debug, Clone)]
pub struct ConvertError {
    /// `E-CONV-PREFLIGHT` (input inconsistency / LOCK present),
    /// `E-CONV-OUTPUT` (output dir exists / io), `E-CONV-ENVELOPE` (input
    /// outside the measured stage-1 envelope), `E-CONV-INPUT` (io / open),
    /// `E-CONV-IMMUTABLE` (input changed under the converter),
    /// `E-CONV-VERIFY` (post-write verification failed).
    pub code: &'static str,
    /// Human-oriented detail.
    pub detail: String,
}

impl std::fmt::Display for ConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for ConvertError {}

fn cerr(code: &'static str, detail: impl std::fmt::Display) -> ConvertError {
    ConvertError {
        code,
        detail: detail.to_string(),
    }
}

// ── Preflight (§10.3 duty 1; round-012-pre D1) ─────────────────────

/// Preflight facts about a consistent input base.
#[derive(Debug, Clone)]
pub struct Preflight {
    /// current.json version (== manifest_index.json latest_version).
    pub manifest_version: u64,
    /// db_config.json shard_count (also the output routing modulus, Q9).
    pub shard_count: u16,
}

/// Verify the input can be opened WITHOUT any write. Aborts (typed, no write)
/// when: LOCK exists (the differential precedent REMOVES it — the converter
/// must not); current.json / manifest_index.json disagree (ManifestStore::open
/// would rebuild_index and PERSIST into the input); db_config.json is absent.
pub fn preflight(input: &Path) -> Result<Preflight, ConvertError> {
    if !input.is_dir() {
        return Err(cerr(
            "E-CONV-INPUT",
            format!("input is not a directory: {}", input.display()),
        ));
    }
    if input.join("LOCK").exists() {
        return Err(cerr(
            "E-CONV-PREFLIGHT",
            format!(
                "LOCK present in {} — another process may own this base; the converter never \
                 removes a LOCK (read-only contract)",
                input.display()
            ),
        ));
    }
    let read_json = |name: &str| -> Result<serde_json::Value, ConvertError> {
        let path = input.join(name);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| cerr("E-CONV-INPUT", format!("cannot read {}: {e}", path.display())))?;
        serde_json::from_str(&text)
            .map_err(|e| cerr("E-CONV-INPUT", format!("malformed {}: {e}", path.display())))
    };
    let current = read_json("current.json")?;
    let version = current
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| cerr("E-CONV-INPUT", "current.json lacks a numeric 'version'"))?;
    let index = read_json("manifest_index.json")?;
    let latest = index
        .get("latest_version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            cerr(
                "E-CONV-INPUT",
                "manifest_index.json lacks a numeric 'latest_version'",
            )
        })?;
    if version != latest {
        return Err(cerr(
            "E-CONV-PREFLIGHT",
            format!(
                "index inconsistency: current.json version {version} != manifest_index.json \
                 latest_version {latest} — opening would trigger rebuild_index, which WRITES \
                 manifest_index.json into the input (storage_v2/manifest.rs); aborting instead"
            ),
        ));
    }
    let config = read_json("db_config.json")?;
    let shard_count = config
        .get("shard_count")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| cerr("E-CONV-INPUT", "db_config.json lacks 'shard_count'"))?;
    Ok(Preflight {
        manifest_version: version,
        shard_count: u16::try_from(shard_count)
            .map_err(|_| cerr("E-CONV-INPUT", "shard_count exceeds u16"))?,
    })
}

/// Recursive sha256 + total size of a directory: files in sorted relative-path
/// order, each contributing `path \0 varint-free len \0 content` — the input
/// immutability and output determinism instrument (round-012-pre E1/E7).
pub fn dir_recursive_sha256(root: &Path) -> Result<(String, u64), ConvertError> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| cerr("E-CONV-INPUT", format!("read_dir {}: {e}", dir.display())))?;
        for entry in entries {
            let path = entry
                .map_err(|e| cerr("E-CONV-INPUT", format!("dir entry: {e}")))?
                .path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files.sort();
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    for path in &files {
        let rel = path
            .strip_prefix(root)
            .expect("walked under root")
            .to_string_lossy()
            .into_owned();
        let content = std::fs::read(path)
            .map_err(|e| cerr("E-CONV-INPUT", format!("read {}: {e}", path.display())))?;
        total += content.len() as u64;
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        hasher.update((content.len() as u64).to_le_bytes());
        hasher.update([0u8]);
        hasher.update(&content);
    }
    Ok((
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        total,
    ))
}

// ── Input loading (S1/S2) ──────────────────────────────────────────

/// One deduplicated input node record with its §10.1 assertion mapping.
#[derive(Debug, Clone)]
pub struct NodeIn {
    /// The record (metadata verbatim).
    pub rec: NodeRecordV2,
    /// Parsed metadata object (empty map for empty metadata).
    pub meta: serde_json::Map<String, serde_json::Value>,
    /// author ← `_source` (missing → `$legacy`).
    pub author: String,
    /// tick ← `_generation` (missing/unparseable → 0).
    pub tick: u64,
    /// Whether `_source` was present.
    pub had_source: bool,
    /// Whether `_generation` was present AND parseable.
    pub had_generation: bool,
}

/// Edge companion of [`NodeIn`].
#[derive(Debug, Clone)]
pub struct EdgeIn {
    /// The record.
    pub rec: EdgeRecordV2,
    /// Parsed metadata object.
    pub meta: serde_json::Map<String, serde_json::Value>,
    /// author ← `_source`.
    pub author: String,
    /// tick ← `_generation`.
    pub tick: u64,
    /// Whether `_source` was present.
    pub had_source: bool,
    /// Whether `_generation` was present AND parseable.
    pub had_generation: bool,
}

/// S1/S2 counters (part of the C7 report).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct LoadCounters {
    /// Node records enumerated (post-tombstone, pre-dedup).
    pub node_records_enumerated: u64,
    /// Edge records enumerated.
    pub edge_records_enumerated: u64,
    /// Exact-duplicate node records collapsed (S2-i).
    pub node_exact_duplicates: u64,
    /// Exact-duplicate edge records collapsed.
    pub edge_exact_duplicates: u64,
    /// Non-identical node records sharing (id, author, tick) — older dropped
    /// (S2-ii, expected 0 on the real base).
    pub node_shadowed_dropped: u64,
    /// Edge companion of the above.
    pub edge_shadowed_dropped: u64,
    /// Distinct node ids.
    pub distinct_node_ids: u64,
    /// Node ids with more than one kept record (the §2.3 conflict class).
    pub multi_record_node_ids: u64,
    /// Records with a present but non-u64-parseable `_generation` (S8,
    /// expected 0).
    pub unparseable_generation: u64,
    /// Records with a present but non-string `_source` (S8, expected 0).
    pub non_string_source: u64,
}

fn parse_meta(
    metadata: &str,
    what: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, ConvertError> {
    if metadata.is_empty() {
        return Ok(serde_json::Map::new());
    }
    match serde_json::from_str::<serde_json::Value>(metadata) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        Ok(other) => Err(cerr(
            "E-CONV-ENVELOPE",
            format!("{what}: non-object metadata ({other}) — outside the measured envelope"),
        )),
        Err(e) => Err(cerr(
            "E-CONV-ENVELOPE",
            format!("{what}: unparseable metadata: {e}"),
        )),
    }
}

#[allow(clippy::type_complexity)]
fn provenance_of(
    meta: &serde_json::Map<String, serde_json::Value>,
    counters: &mut LoadCounters,
) -> (String, u64, bool, bool) {
    let (author, had_source) = match meta.get("_source") {
        None => (LEGACY_AUTHOR.to_string(), false),
        Some(serde_json::Value::String(s)) => (s.clone(), true),
        Some(_) => {
            counters.non_string_source += 1;
            (LEGACY_AUTHOR.to_string(), false)
        }
    };
    let (tick, had_generation) = match meta.get("_generation") {
        None => (0, false),
        Some(v) => match v
            .as_u64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
        {
            Some(g) => (g, true),
            None => {
                counters.unparseable_generation += 1;
                (0, false)
            }
        },
    };
    (author, tick, had_source, had_generation)
}

/// Enumerate + dedup the input base (S1/S2). Deterministic: the snapshot's
/// descriptor-driven newest-first order.
#[allow(clippy::type_complexity)]
pub fn load_input(
    input: &Path,
) -> Result<(Vec<NodeIn>, Vec<EdgeIn>, LoadCounters), ConvertError> {
    let fs = LsmFactStore::open(input).map_err(|e| cerr("E-CONV-INPUT", e))?;
    load_input_from(&fs)
}

/// [`load_input`] over an already-opened store (the converter reuses one open).
#[allow(clippy::type_complexity)]
pub fn load_input_from(
    fs: &LsmFactStore,
) -> Result<(Vec<NodeIn>, Vec<EdgeIn>, LoadCounters), ConvertError> {
    let mut counters = LoadCounters::default();
    let snap = fs.snapshot();
    let pinned = fs.read_snapshot_of(&snap);
    let (node_versions, edge_versions) = {
        let store = fs.store_read();
        let n = store
            .iter_node_versions_at(&pinned)
            .map_err(|e| cerr("E-CONV-INPUT", e))?;
        let e = store
            .iter_edge_versions_at(&pinned)
            .map_err(|e| cerr("E-CONV-INPUT", e))?;
        (n, e)
    };

    let mut nodes: Vec<NodeIn> = Vec::with_capacity(node_versions.len());
    let mut node_seen: HashMap<u128, Vec<usize>> = HashMap::new();
    for (rec, fields) in node_versions {
        if fields.is_some() {
            return Err(cerr(
                "E-CONV-ENVELOPE",
                format!(
                    "node {:x} carries derived (v3) columns — stage 1 converts record-model \
                     (v2) bases only",
                    rec.id
                ),
            ));
        }
        if rec.node_type == SUPERSEDES_NODE_TYPE {
            return Err(cerr(
                "E-CONV-ENVELOPE",
                format!("reserved supersedes record {:x} in a stage-1 input", rec.id),
            ));
        }
        if rec.content_hash != 0 {
            return Err(cerr(
                "E-CONV-ENVELOPE",
                format!(
                    "node {:x} has content_hash {} — MEASURED 0/503,443 on the real base; \
                     the stage-1 vocabulary does not carry it",
                    rec.id, rec.content_hash
                ),
            ));
        }
        counters.node_records_enumerated += 1;
        let meta = parse_meta(&rec.metadata, &format!("node {:x}", rec.id))?;
        let (author, tick, had_source, had_generation) = provenance_of(&meta, &mut counters);
        let candidate = NodeIn {
            rec,
            meta,
            author,
            tick,
            had_source,
            had_generation,
        };
        let slots = node_seen.entry(candidate.rec.id).or_default();
        // Newest-first enumeration: an existing entry with the same (author,
        // tick) shadows this older version (S2) — identical records count as
        // exact duplicates, differing ones as shadowed drops.
        let mut shadowed = false;
        for &i in slots.iter() {
            let kept: &NodeIn = &nodes[i];
            if kept.author == candidate.author && kept.tick == candidate.tick {
                if kept.rec == candidate.rec {
                    counters.node_exact_duplicates += 1;
                } else {
                    counters.node_shadowed_dropped += 1;
                }
                shadowed = true;
                break;
            }
        }
        if !shadowed {
            slots.push(nodes.len());
            nodes.push(candidate);
        }
    }
    counters.distinct_node_ids = node_seen.len() as u64;
    counters.multi_record_node_ids = node_seen.values().filter(|v| v.len() > 1).count() as u64;

    let mut edges: Vec<EdgeIn> = Vec::with_capacity(edge_versions.len());
    let mut edge_seen: HashMap<(u128, u128, String), Vec<usize>> = HashMap::new();
    for (rec, fields) in edge_versions {
        if fields.is_some() {
            return Err(cerr(
                "E-CONV-ENVELOPE",
                format!(
                    "edge {:x}->{:x} '{}' carries derived (v3) columns — stage 1 converts \
                     record-model (v2) bases only",
                    rec.src, rec.dst, rec.edge_type
                ),
            ));
        }
        counters.edge_records_enumerated += 1;
        let what = format!("edge {:x}->{:x} '{}'", rec.src, rec.dst, rec.edge_type);
        let meta = parse_meta(&rec.metadata, &what)?;
        let (author, tick, had_source, had_generation) = provenance_of(&meta, &mut counters);
        let candidate = EdgeIn {
            rec,
            meta,
            author,
            tick,
            had_source,
            had_generation,
        };
        let key = (
            candidate.rec.src,
            candidate.rec.dst,
            candidate.rec.edge_type.clone(),
        );
        let slots = edge_seen.entry(key).or_default();
        let mut shadowed = false;
        for &i in slots.iter() {
            let kept: &EdgeIn = &edges[i];
            if kept.author == candidate.author && kept.tick == candidate.tick {
                if kept.rec == candidate.rec {
                    counters.edge_exact_duplicates += 1;
                } else {
                    counters.edge_shadowed_dropped += 1;
                }
                shadowed = true;
                break;
            }
        }
        if !shadowed {
            slots.push(edges.len());
            edges.push(candidate);
        }
    }
    Ok((nodes, edges, counters))
}

// ── Decomposition (§6.2; S4/S5/S6, Q6/Q8, step 4) ──────────────────

/// Decomposition counters (part of the C7 report).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct DecomposeCounters {
    /// Blob copies of column-authoritative keys skipped (S5).
    pub blob_copies_skipped: u64,
    /// Of those, copies whose value DIFFERS from the column (pollution).
    pub blob_copies_differing: u64,
    /// span/5 facts emitted (Q6).
    pub span_facts: u64,
    /// Subjects carrying SOME but not all four span keys as i64 integers.
    pub partial_span_subjects: u64,
    /// Metadata keys prefix-guarded with `$meta:` (S6, expected 0).
    pub meta_prefixed_keys: u64,
    /// Empty semantic_id columns (fact omitted).
    pub empty_sid: u64,
    /// Empty name columns (fact omitted).
    pub empty_name: u64,
    /// Empty file columns (fact omitted).
    pub empty_file: u64,
    /// Retyped id-valued strings per predicate (step 4).
    pub retyped: BTreeMap<String, u64>,
    /// String values under retyped keys NOT parsing as canonical decimal u128.
    pub retype_misses: u64,
    /// Non-scalar metadata values carried as `$json` Terms (S4).
    pub json_composite_values: u64,
    /// JSON nulls carried as `$null` Terms (S4).
    pub null_values: u64,
}

/// A proto-fact before interning (predicate/author by NAME).
#[derive(Debug, Clone)]
struct ProtoFact {
    persp: u32,
    pred: String,
    tuple: Vec<Value>,
    author: String,
    tick: u64,
}

/// S6: guard a metadata key against the reserved/core names, edge-type names
/// and the guard prefix itself.
fn guard_meta_key(key: &str, edge_types: &HashSet<String>, c: &mut DecomposeCounters) -> String {
    if CORE_RESERVED.contains(&key) || edge_types.contains(key) || key.starts_with(META_PREFIX) {
        c.meta_prefixed_keys += 1;
        format!("{META_PREFIX}{key}")
    } else {
        key.to_string()
    }
}

/// S4 value typing (+ step-4 retyping for the three Adjacency predicates).
fn json_to_value(
    key: &str,
    v: &serde_json::Value,
    c: &mut DecomposeCounters,
) -> Result<Value, ConvertError> {
    if RETYPED_PREDS.contains(&key) {
        if let serde_json::Value::String(s) = v {
            if let Ok(id) = s.parse::<u128>() {
                if id.to_string() == *s {
                    *c.retyped.entry(key.to_string()).or_default() += 1;
                    return Ok(Value::Id(id));
                }
            }
            c.retype_misses += 1;
            return Ok(Value::Str(s.clone()));
        }
    }
    Ok(match v {
        serde_json::Value::String(s) => Value::Str(s.clone()),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Int(i)
            } else if let Some(u) = n.as_u64() {
                Value::big_int_from_decimal(&u.to_string())
                    .expect("u64 decimal is a canonical integer")
            } else {
                Value::float(n.as_f64().expect("JSON number is i64, u64 or f64"))
            }
        }
        serde_json::Value::Bool(b) => {
            let functor = if *b { "$true" } else { "$false" };
            Value::Term(std::sync::Arc::new(
                TermBlob::new(functor, Vec::<Value>::new()).expect("0-ary term is canonical"),
            ))
        }
        serde_json::Value::Null => {
            c.null_values += 1;
            Value::Term(std::sync::Arc::new(
                TermBlob::new("$null", Vec::<Value>::new()).expect("0-ary term is canonical"),
            ))
        }
        composite @ (serde_json::Value::Object(_) | serde_json::Value::Array(_)) => {
            c.json_composite_values += 1;
            let text = serde_json::to_string(composite).expect("re-serializable JSON");
            Value::Term(std::sync::Arc::new(
                TermBlob::new("$json", vec![Value::Str(text)]).expect("Str arg is canonical"),
            ))
        }
    })
}

/// Decompose one metadata object into per-key facts (shared node/edge path).
#[allow(clippy::too_many_arguments)]
fn decompose_meta(
    subject: u128,
    meta: &serde_json::Map<String, serde_json::Value>,
    author: &str,
    tick: u64,
    edge_types: &HashSet<String>,
    column_check: Option<(&str, &str, &str)>, // (name, file, semantic_id) column values
    facts: &mut Vec<ProtoFact>,
    c: &mut DecomposeCounters,
) -> Result<(), ConvertError> {
    // Q6: the A″ span gate — all four keys present as i64 JSON integers.
    let span_vals: Vec<Option<i64>> = SPAN_KEYS
        .iter()
        .map(|k| meta.get(*k).and_then(serde_json::Value::as_i64))
        .collect();
    let span_present = span_vals.iter().filter(|v| v.is_some()).count();
    let full_span = span_present == SPAN_KEYS.len();
    if full_span {
        c.span_facts += 1;
        let mut tuple = vec![Value::Id(subject)];
        tuple.extend(span_vals.iter().map(|v| Value::Int(v.expect("full span"))));
        facts.push(ProtoFact {
            persp: PERSP_MAIN,
            pred: "span".to_string(),
            tuple,
            author: author.to_string(),
            tick,
        });
    } else if span_present > 0 {
        c.partial_span_subjects += 1;
    }
    for (k, v) in meta {
        if RESERVED_META_KEYS.contains(&k.as_str()) {
            continue;
        }
        if let Some((name, file, sid)) = column_check {
            if COLUMN_META_KEYS.contains(&k.as_str()) {
                c.blob_copies_skipped += 1;
                let column_value = match k.as_str() {
                    "name" => name,
                    "file" => file,
                    _ => sid,
                };
                if v.as_str() != Some(column_value) {
                    c.blob_copies_differing += 1;
                }
                continue;
            }
        }
        if full_span && SPAN_KEYS.contains(&k.as_str()) && v.as_i64().is_some() {
            continue; // collapsed into span/5
        }
        let pred = guard_meta_key(k, edge_types, c);
        let value = json_to_value(k, v, c)?;
        facts.push(ProtoFact {
            persp: PERSP_MAIN,
            pred,
            tuple: vec![Value::Id(subject), value],
            author: author.to_string(),
            tick,
        });
    }
    Ok(())
}

// ── The interned fact set ──────────────────────────────────────────

/// One live fact of the converted store, with its deduped assertion set
/// (author id, tick) — S3: the aid dedup key.
#[derive(Debug, Clone)]
pub struct ConvFact {
    /// Perspective id ([`PERSP_MAIN`] | [`PERSP_AUDIT`]).
    pub persp: u32,
    /// Final predicate id (shortlex rank).
    pub pred: u32,
    /// The tuple.
    pub tuple: Vec<Value>,
    /// Assertions, deduped by (author, tick), sorted (author ids are shortlex
    /// name ranks, so id order == canonical name order).
    pub asserts: BTreeSet<(u32, u64)>,
}

/// The fully-interned conversion state handed to the writer.
pub struct Converted {
    /// Predicate names in id order (shortlex).
    pub pred_names: Vec<String>,
    /// Author names in id order (shortlex).
    pub author_names: Vec<String>,
    /// The catalog (ids == shortlex ranks by construction).
    pub catalog: PredicateCatalog,
    /// Reader-facing kind per predicate id.
    pub kinds: Vec<&'static str>,
    /// Facts keyed by (pred, persp, tuple canon bytes).
    pub facts: BTreeMap<(u32, u32, Vec<u8>), ConvFact>,
    /// Load counters.
    pub load: LoadCounters,
    /// Decompose counters.
    pub decompose: DecomposeCounters,
    /// Conflict summaries per predicate name.
    pub conflicts: BTreeMap<String, ConflictSummary>,
    /// §10.1 counters.
    pub legacy: LegacyCounters,
    /// Author pollution counters.
    pub pollution: PollutionCounters,
}

/// §10.1 `$legacy`/tick-0 counters (C7).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct LegacyCounters {
    /// Node records with no `_source` (author = `$legacy`). Expected 917.
    pub legacy_author_nodes: u64,
    /// Edge records with no `_source`. Expected 33,096.
    pub legacy_author_edges: u64,
    /// Node records with no parseable `_generation` (tick 0). Expected 1,153.
    pub tick0_nodes: u64,
    /// Edge records with no parseable `_generation`. Expected 35,929.
    pub tick0_edges: u64,
}

/// sha256-hex author pollution (§10.1 item 2, second branch; Q4).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct PollutionCounters {
    /// Distinct authors that are raw 64-char lowercase hex strings.
    pub hex_authors_distinct: u64,
    /// Assertions carried by hex authors.
    pub hex_author_assertions: u64,
}

/// Per-predicate conflict/5 summary (C7).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ConflictSummary {
    /// Number of conflict/5 facts (one per loser).
    pub count: u64,
    /// Winner VALUE histogram (c1 of the winning fact, stringified).
    pub winner_values: BTreeMap<String, u64>,
    /// Loser VALUE histogram.
    pub loser_values: BTreeMap<String, u64>,
    /// Winner AUTHOR histogram (canonical names).
    pub winner_authors: BTreeMap<String, u64>,
}

fn is_hex_author(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn tuple_canon(tuple: &[Value]) -> Vec<u8> {
    let mut out = Vec::new();
    for v in tuple {
        canon_bytes(v, &mut out).expect("converter tuples are canonical by construction");
    }
    out
}

fn value_display(v: &Value) -> String {
    match v {
        Value::Str(s) => s.clone(),
        Value::Id(x) => format!("id:{x:032x}"),
        Value::Int(i) => i.to_string(),
        Value::Float(f) => f.to_string(),
        Value::BigInt(_) | Value::Term(_) => format!("{v:?}"),
    }
}

/// Decompose + intern + resolve (duties 2-5). `fs` must be the OPEN input store
/// (used for the DEV-P6-1 cross-check of `type` winners).
pub fn build_converted(
    nodes: &[NodeIn],
    edges: &[EdgeIn],
    load: LoadCounters,
    fs: &LsmFactStore,
) -> Result<Converted, ConvertError> {
    let mut dc = DecomposeCounters::default();
    let mut legacy = LegacyCounters::default();

    // Edge-type vocabulary first (the S6 guard needs the full set).
    let mut edge_types: HashSet<String> = HashSet::new();
    for e in edges {
        if CORE_RESERVED.contains(&e.rec.edge_type.as_str()) || e.rec.edge_type.is_empty() {
            return Err(cerr(
                "E-CONV-ENVELOPE",
                format!(
                    "edge_type '{}' collides with a reserved predicate name",
                    e.rec.edge_type
                ),
            ));
        }
        edge_types.insert(e.rec.edge_type.clone());
    }

    // §6.2 decomposition into proto-facts.
    let mut protos: Vec<ProtoFact> = Vec::new();
    let mut node_meta_preds: HashSet<String> = HashSet::new();
    for n in nodes {
        if !n.had_source {
            legacy.legacy_author_nodes += 1;
        }
        if !n.had_generation {
            legacy.tick0_nodes += 1;
        }
        let subject = n.rec.id;
        let push_core = |protos: &mut Vec<ProtoFact>, pred: &str, value: String| {
            protos.push(ProtoFact {
                persp: PERSP_MAIN,
                pred: pred.to_string(),
                tuple: vec![Value::Id(subject), Value::Str(value)],
                author: n.author.clone(),
                tick: n.tick,
            });
        };
        // `type` is always emitted (the reassembly anchor); sid/name/file omit
        // empty columns with counters (round-012-pre D2 precision recorded in
        // round-012).
        push_core(&mut protos, "type", n.rec.node_type.clone());
        if n.rec.semantic_id.is_empty() {
            dc.empty_sid += 1;
        } else {
            push_core(&mut protos, "sid", n.rec.semantic_id.clone());
        }
        if n.rec.name.is_empty() {
            dc.empty_name += 1;
        } else {
            push_core(&mut protos, "name", n.rec.name.clone());
        }
        if n.rec.file.is_empty() {
            dc.empty_file += 1;
        } else {
            push_core(&mut protos, "file", n.rec.file.clone());
        }
        let before = protos.len();
        decompose_meta(
            subject,
            &n.meta,
            &n.author,
            n.tick,
            &edge_types,
            Some((&n.rec.name, &n.rec.file, &n.rec.semantic_id)),
            &mut protos,
            &mut dc,
        )?;
        for p in &protos[before..] {
            node_meta_preds.insert(p.pred.clone());
        }
    }
    for e in edges {
        if !e.had_source {
            legacy.legacy_author_edges += 1;
        }
        if !e.had_generation {
            legacy.tick0_edges += 1;
        }
        // Variant A (Q8): the base binary fact; the EID is COMPUTED, never
        // materialized as edge_of/3.
        protos.push(ProtoFact {
            persp: PERSP_MAIN,
            pred: e.rec.edge_type.clone(),
            tuple: vec![Value::Id(e.rec.src), Value::Id(e.rec.dst)],
            author: e.author.clone(),
            tick: e.tick,
        });
        let eid = fid(
            PERSPECTIVE_MAIN_NAME,
            &e.rec.edge_type,
            &[Value::Id(e.rec.src), Value::Id(e.rec.dst)],
        )
        .expect("edge tuples are canonical");
        decompose_meta(
            eid,
            &e.meta,
            &e.author,
            e.tick,
            &edge_types,
            None,
            &mut protos,
            &mut dc,
        )?;
    }

    // Vocabulary finalization (Q5): names collected fully, ids = shortlex rank.
    let mut pred_names: Vec<String> = protos.iter().map(|p| p.pred.clone()).collect();
    pred_names.push("conflict".to_string()); // reserved, declared even at 0 conflicts
    pred_names.sort_by(|a, b| canon_str_cmp(a, b));
    pred_names.dedup();
    let pred_id_of: HashMap<String, u32> = pred_names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), i as u32))
        .collect();

    let mut author_names: Vec<String> = protos.iter().map(|p| p.author.clone()).collect();
    author_names.push(SEEDED_PRIORITY_HIGH.to_string());
    author_names.push(SEEDED_PRIORITY_LOW.to_string());
    author_names.push(CONVERT_AUTHOR.to_string());
    author_names.sort_by(|a, b| canon_str_cmp(a, b));
    author_names.dedup();
    let author_id_of: HashMap<String, u32> = author_names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), i as u32))
        .collect();

    // Pollution (Q4): register hex authors instead of normalizing them.
    let mut pollution = PollutionCounters {
        hex_authors_distinct: author_names.iter().filter(|a| is_hex_author(a)).count() as u64,
        hex_author_assertions: 0,
    };

    // The catalog (§3.1): every predicate declared; strategy per round-012-pre
    // D2/F1; Functional five with the R-1a seeded pair (Q7).
    let seeded_pair: Box<[AuthorId]> = Box::new([
        AuthorId(author_id_of[SEEDED_PRIORITY_HIGH]),
        AuthorId(author_id_of[SEEDED_PRIORITY_LOW]),
    ]);
    // Value-shape profile: does a meta predicate ever carry a Term?
    let mut has_term: HashSet<&str> = HashSet::new();
    for p in &protos {
        if p.tuple.iter().any(|v| matches!(v, Value::Term(_))) {
            has_term.insert(p.pred.as_str());
        }
    }
    let mut catalog = PredicateCatalog::new();
    let mut kinds: Vec<&'static str> = Vec::with_capacity(pred_names.len());
    for name in &pred_names {
        let functional = FUNCTIONAL_PREDS.contains(&name.as_str());
        let (kind, arity, strategy, key_cols, reverse): (
            &'static str,
            u8,
            PhysStrategy,
            Box<[u8]>,
            Option<Box<[u8]>>,
        ) = if ["sid", "type", "name", "file"].contains(&name.as_str()) {
            (
                "core",
                2,
                PhysStrategy::Attribute,
                Box::new([0]),
                Some(Box::new([1, 0])), // §6.3 matrix: reverse YES
            )
        } else if edge_types.contains(name.as_str()) {
            (
                "edge",
                2,
                PhysStrategy::Adjacency,
                Box::new([0, 1]),
                Some(Box::new([1, 0])), // §6.3 matrix: reverse YES
            )
        } else if RETYPED_PREDS.contains(&name.as_str()) {
            (
                "retyped",
                2,
                PhysStrategy::Adjacency, // §10.3 step 4
                Box::new([0, 1]),
                Some(Box::new([1, 0])), // Adjacency declares both runs (§3.1)
            )
        } else if name == "span" {
            ("span", 5, PhysStrategy::Composite, Box::new([0]), None)
        } else if name == "conflict" {
            ("conflict", 5, PhysStrategy::Nary, Box::new([0]), None)
        } else {
            let strategy = if has_term.contains(name.as_str()) {
                PhysStrategy::Nary
            } else {
                PhysStrategy::Attribute
            };
            ("meta", 2, strategy, Box::new([0]), None) // §6.3: metadata NO reverse
        };
        kinds.push(kind);
        let decl = PredicateDecl {
            id: crate::derive::catalog::CatalogPredicateId(0), // assigned by declare()
            name: name.clone(),
            arity,
            strategy,
            cardinality: if functional {
                Cardinality::Functional
            } else {
                Cardinality::MultiValued
            },
            temporal: TemporalScope::Timeless,
            semiring: BOOLTAG_SEMIRING_ID,
            key_cols,
            reverse,
            author_priority: if functional {
                seeded_pair.clone()
            } else {
                Box::new([])
            },
            stats: PredicateStats::default(),
        };
        let assigned = catalog.declare(decl).map_err(|e| cerr("E-CONV-INPUT", e))?;
        debug_assert_eq!(assigned.0, pred_id_of[name]);
    }

    // Intern the proto-facts (S3 aid dedup inside the BTreeSet).
    let mut facts: BTreeMap<(u32, u32, Vec<u8>), ConvFact> = BTreeMap::new();
    for p in protos {
        let pred = pred_id_of[&p.pred];
        let author = author_id_of[&p.author];
        if is_hex_author(&p.author) {
            pollution.hex_author_assertions += 1;
        }
        let key = (pred, p.persp, tuple_canon(&p.tuple));
        let entry = facts.entry(key).or_insert_with(|| ConvFact {
            persp: p.persp,
            pred,
            tuple: p.tuple.clone(),
            asserts: BTreeSet::new(),
        });
        entry.asserts.insert((author, p.tick));
    }


    // Functional resolution (duty 5) under R-1a, conflict/5 durable in audit
    // (losers stay LIVE — Q10).
    let mut conflicts: BTreeMap<String, ConflictSummary> = BTreeMap::new();
    let convert_author = author_id_of[CONVERT_AUTHOR];
    let conflict_pred = pred_id_of["conflict"];
    let mut conflict_facts: Vec<ConvFact> = Vec::new();
    let mut type_winners: BTreeMap<u128, (String, String, u64)> = BTreeMap::new();
    for fname in FUNCTIONAL_PREDS {
        let Some(&pid) = pred_id_of.get(fname) else {
            continue; // predicate absent from this base (e.g. no __exported)
        };
        let decl = catalog.get(fname).expect("declared above");
        let priority: Vec<u32> = decl.author_priority.iter().map(|a| a.0).collect();
        // Group this predicate's main-perspective facts by subject (c0).
        let mut by_subject: BTreeMap<u128, Vec<&ConvFact>> = BTreeMap::new();
        for f in facts
            .range((pid, PERSP_MAIN, Vec::new())..(pid, PERSP_MAIN + 1, Vec::new()))
            .map(|(_, f)| f)
        {
            let Value::Id(subject) = f.tuple[0] else {
                return Err(cerr(
                    "E-CONV-ENVELOPE",
                    format!("Functional predicate '{fname}' with a non-Id subject"),
                ));
            };
            by_subject.entry(subject).or_default().push(f);
        }
        let summary = conflicts.entry(fname.to_string()).or_default();
        for (subject, group) in by_subject {
            if group.len() < 2 {
                continue;
            }
            let fids: Vec<u128> = group
                .iter()
                .map(|f| {
                    fid(PERSPECTIVE_MAIN_NAME, fname, &f.tuple)
                        .expect("converter tuples are canonical")
                })
                .collect();
            let r = resolve_r1a(&group, &fids, &priority);
            let winner_value = value_display(&group[r.winner_idx].tuple[1]);
            *summary
                .winner_authors
                .entry(author_names[r.winner_author as usize].clone())
                .or_default() += 1;
            if fname == "type" {
                type_winners.insert(
                    subject,
                    (
                        winner_value.clone(),
                        author_names[r.winner_author as usize].clone(),
                        r.winner_tick,
                    ),
                );
            }
            let tick_int = i64::try_from(r.winner_tick)
                .map_err(|_| cerr("E-CONV-ENVELOPE", "winner tick exceeds i64"))?;
            for (i, f) in group.iter().enumerate() {
                if i == r.winner_idx {
                    continue;
                }
                summary.count += 1;
                *summary.winner_values.entry(winner_value.clone()).or_default() += 1;
                *summary
                    .loser_values
                    .entry(value_display(&f.tuple[1]))
                    .or_default() += 1;
                // OQ-1/OQ-2 columns: [Id(subject), Str(pred NAME),
                // Id(winner_fid), Id(loser_fid), Int(winner tick)].
                let tuple = vec![
                    Value::Id(subject),
                    Value::Str(fname.to_string()),
                    Value::Id(fids[r.winner_idx]),
                    Value::Id(fids[i]),
                    Value::Int(tick_int),
                ];
                let mut asserts = BTreeSet::new();
                asserts.insert((convert_author, r.winner_tick));
                conflict_facts.push(ConvFact {
                    persp: PERSP_AUDIT,
                    pred: conflict_pred,
                    tuple,
                    asserts,
                });
            }
        }
    }
    for f in conflict_facts {
        let key = (f.pred, f.persp, tuple_canon(&f.tuple));
        facts.insert(key, f);
    }

    // DEV-P6-1 cross-check: the base-five resolver (P5, R-1a) must agree with
    // the converter's `type` winner on EVERY multi-live subject — the
    // (winner, conflicts) return-channel consumption the spec intends.
    if !type_winners.is_empty() {
        let snap = fs.snapshot();
        let type_id = fs.catalog().get("type").expect("base type decl").id;
        for (&subject, (our_value, our_author, our_tick)) in &type_winners {
            let resolved = fs
                .resolve_functional(&snap, type_id, PERSPECTIVE_MAIN, subject)
                .map_err(|e| cerr("E-CONV-VERIFY", e))?
                .ok_or_else(|| {
                    cerr(
                        "E-CONV-VERIFY",
                        format!("base resolve_functional found no winner for {subject:x}"),
                    )
                })?;
            let (row, _base_conflicts) = resolved;
            let base_value = match &row.key.tuple[1] {
                Value::Str(s) => s.clone(),
                other => value_display(other),
            };
            if &base_value != our_value {
                return Err(cerr(
                    "E-CONV-VERIFY",
                    format!(
                        "DEV-P6-1 cross-check failed for subject {subject:x}: converter type \
                         winner '{our_value}' (author {our_author}, tick {our_tick}) vs base \
                         resolve_functional winner '{base_value}'"
                    ),
                ));
            }
        }
    }

    Ok(Converted {
        pred_names,
        author_names,
        catalog,
        kinds,
        facts,
        load,
        decompose: dc,
        conflicts,
        legacy,
        pollution,
    })
}

/// The R-1a resolution outcome for one (predicate, subject) group.
struct Resolution {
    winner_idx: usize,
    winner_author: u32,
    winner_tick: u64,
}

/// The R-1a total order as successive filters over the live candidate
/// ASSERTIONS (the exact resolve_functional_with contract, facts/lsm.rs:2037):
/// F1 max tick → F2 seeded priority table (IFF every survivor listed and not
/// all one rank) → F3 author canon-order (author ids ARE shortlex name ranks,
/// so min id == lesser canonical name) → F4 min fid.
fn resolve_r1a(group: &[&ConvFact], fids: &[u128], priority: &[u32]) -> Resolution {
    struct Cand {
        idx: usize,
        author: u32,
        tick: u64,
        fid: u128,
    }
    let mut cands: Vec<Cand> = group
        .iter()
        .enumerate()
        .flat_map(|(i, f)| {
            f.asserts.iter().map(move |&(author, tick)| Cand {
                idx: i,
                author,
                tick,
                fid: 0,
            })
        })
        .collect();
    for c in &mut cands {
        c.fid = fids[c.idx];
    }
    // F1: max tick (freshness dominates, R-1a ground (d)).
    let max_tick = cands.iter().map(|c| c.tick).max().expect("non-empty group");
    cands.retain(|c| c.tick == max_tick);
    // F2: the priority table.
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
    // F3: author canon-order.
    if cands.len() > 1 {
        let min_author = cands.iter().map(|c| c.author).min().expect("non-empty");
        cands.retain(|c| c.author == min_author);
    }
    // F4: min fid — total by construction (distinct facts have distinct fids).
    let winner = cands
        .iter()
        .min_by_key(|c| c.fid)
        .expect("non-empty after filters");
    Resolution {
        winner_idx: winner.idx,
        winner_author: winner.author,
        winner_tick: winner.tick,
    }
}

// ── Physical writer (duty 2's physics: F1/F2 layout, §5.2 routing) ──

/// `blake3_u64` of a value's canon bytes — the §5.2 routing hash
/// (round-012-pre F2: uniform canon-bytes hashing for Id and non-Id keys).
pub fn route_hash(v: &Value) -> u64 {
    let mut b = Vec::new();
    canon_bytes(v, &mut b).expect("routing keys are canonical");
    let h = blake3::hash(&b);
    u64::from_le_bytes(h.as_bytes()[..8].try_into().expect("8 bytes"))
}

fn sort_rows_for_run(rows: &mut [PhysRow], cols: &[u8]) {
    rows.sort_by(|a, b| {
        for &c in cols {
            let ord = a.tuple[c as usize].cmp(&b.tuple[c as usize]);
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        }
        // Full-tuple canon order, then (author, tick) — total and
        // process-invariant (author ids are shortlex name ranks).
        for (x, y) in a.tuple.iter().zip(b.tuple.iter()) {
            let ord = x.cmp(y);
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        }
        (a.persp, a.author, a.tick).cmp(&(b.persp, b.author, b.tick))
    });
}

/// Write every fact segment of the converted store; returns the descriptors in
/// canonical (predicate, direction, shard) order plus the total physical rows.
pub fn write_store(
    conv: &Converted,
    output: &Path,
    shard_count: u16,
) -> Result<(Vec<SegmentJson>, u64), ConvertError> {
    let mut descriptors: Vec<SegmentJson> = Vec::new();
    let mut rows_total: u64 = 0;
    for pid in 0..conv.pred_names.len() as u32 {
        let decl = conv
            .catalog
            .get(&conv.pred_names[pid as usize])
            .expect("declared");
        // Materialize this predicate's physical rows (fact × assertion).
        let mut rows: Vec<PhysRow> = Vec::new();
        for (_, f) in conv
            .facts
            .range((pid, 0, Vec::new())..(pid + 1, 0, Vec::new()))
        {
            for &(author, tick) in &f.asserts {
                rows.push(PhysRow {
                    tuple: f.tuple.clone(),
                    persp: f.persp,
                    author,
                    tick,
                });
            }
        }
        if rows.is_empty() {
            continue;
        }
        let runs: Vec<(u8, Vec<u8>)> = {
            let mut r = vec![(DIR_FWD, decl.key_cols.to_vec())];
            if let Some(rev) = &decl.reverse {
                r.push((DIR_REV, rev.to_vec()));
            }
            r
        };
        for (dir, cols) in runs {
            let leading = cols[0] as usize;
            // §5.2/F2: each run routes by ITS OWN leading key column.
            let mut buckets: BTreeMap<u16, Vec<PhysRow>> = BTreeMap::new();
            for row in &rows {
                let shard = (route_hash(&row.tuple[leading]) % u64::from(shard_count)) as u16;
                buckets.entry(shard).or_default().push(row.clone());
            }
            for (shard, mut bucket) in buckets {
                sort_rows_for_run(&mut bucket, &cols);
                let dir_name = if dir == DIR_FWD { "fwd" } else { "rev" };
                let shard_dir = output.join("shards").join(format!("shard_{shard:04}"));
                std::fs::create_dir_all(&shard_dir)
                    .map_err(|e| cerr("E-CONV-OUTPUT", format!("mkdir shards: {e}")))?;
                let rel = format!("shards/shard_{shard:04}/pred_{pid:06}_{dir_name}.seg");
                let path = output.join(&rel);
                let meta = write_segment(&path, pid, dir, decl.arity, &bucket, leading)
                    .map_err(|e| cerr("E-CONV-OUTPUT", e))?;
                rows_total += meta.rows;
                descriptors.push(SegmentJson {
                    predicate: pid,
                    shard,
                    direction: dir_name.to_string(),
                    path: rel,
                    rows: meta.rows,
                    bytes: meta.bytes,
                    zone_min_hex: meta.zone_min_hex,
                    zone_max_hex: meta.zone_max_hex,
                    bloom_k: meta.bloom_k,
                    bloom_m_bits: meta.bloom_m_bits,
                    sha256: meta.sha256,
                });
            }
        }
    }
    Ok((descriptors, rows_total))
}

fn strategy_name(s: PhysStrategy) -> &'static str {
    match s {
        PhysStrategy::Adjacency => "Adjacency",
        PhysStrategy::Attribute => "Attribute",
        PhysStrategy::Composite => "Composite",
        PhysStrategy::Nary => "Nary",
        PhysStrategy::Reified => "Reified",
    }
}

/// Assemble the manifest (canonical order everywhere; sha filled by the caller
/// AFTER the reader computes it over the written segments).
pub fn build_manifest(
    conv: &Converted,
    segments: Vec<SegmentJson>,
    shard_count: u16,
    provenance: ProvenanceJson,
) -> RoflManifest {
    let catalog: Vec<DeclJson> = conv
        .pred_names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let decl = conv.catalog.get(name).expect("declared");
            let mut live_facts: u64 = 0;
            let mut live_asserts: u64 = 0;
            for (_, f) in conv
                .facts
                .range((i as u32, 0, Vec::new())..(i as u32 + 1, 0, Vec::new()))
            {
                live_facts += 1;
                live_asserts += f.asserts.len() as u64;
            }
            DeclJson {
                id: i as u32,
                name: name.clone(),
                kind: conv.kinds[i].to_string(),
                arity: decl.arity,
                strategy: strategy_name(decl.strategy).to_string(),
                cardinality: match decl.cardinality {
                    Cardinality::Functional => "Functional".to_string(),
                    Cardinality::MultiValued => "MultiValued".to_string(),
                },
                temporal: "Timeless".to_string(),
                semiring: decl.semiring,
                key_cols: decl.key_cols.to_vec(),
                reverse: decl.reverse.as_ref().map(|r| r.to_vec()),
                author_priority: decl
                    .author_priority
                    .iter()
                    .map(|a| conv.author_names[a.0 as usize].clone())
                    .collect(),
                live_facts,
                live_asserts,
                stats_distinct: Vec::new(), // «not computed» sentinel (§3.4/P3 note)
                stats_max_fanout: 0,
                stats_updated_at_tx: 0,
            }
        })
        .collect();
    RoflManifest {
        format: FORMAT_TAG.to_string(),
        shard_count,
        perspectives: PERSP_NAMES.iter().map(|s| s.to_string()).collect(),
        authors: conv.author_names.clone(),
        catalog,
        segments,
        provenance,
        perspective_ruling: format!(
            "§10.1: perspective is unrecoverable from the record format — every converted \
             fact is asserted in perspective '{}'; perspective '{}' carries only the \
             converter's conflict/5 facts",
            PERSPECTIVE_MAIN_NAME, PERSPECTIVE_AUDIT_NAME
        ),
        canonical_state_sha: String::new(),
    }
}

// ── The C7 report ──────────────────────────────────────────────────

/// Input provenance section of the report.
#[derive(Debug, Clone, Serialize)]
pub struct InputJson {
    /// Input path as given.
    pub path: String,
    /// Recursive sha256 before conversion.
    pub recursive_sha256: String,
    /// Recursive sha256 after conversion (equality asserted by `run`).
    pub recursive_sha256_after: String,
    /// Total bytes.
    pub size_bytes: u64,
    /// Manifest version (preflight-verified).
    pub manifest_version: u64,
}

/// Output section of the report.
#[derive(Debug, Clone, Serialize)]
pub struct OutputJson {
    /// Output store path.
    pub path: String,
    /// Routing modulus (Q9: = input shard_count).
    pub shard_count: u16,
    /// Recursive sha256 of the output dir — the determinism instrument.
    pub recursive_sha256: String,
    /// Total output bytes.
    pub size_bytes: u64,
    /// Segment file count.
    pub segment_files: u64,
    /// Declared predicates.
    pub predicates: u64,
    /// Interned authors.
    pub authors: u64,
}

/// §9.4 metrics (computed by the READER over the written store).
#[derive(Debug, Clone, Serialize)]
pub struct MetricsJson {
    /// Live `sid` facts.
    pub entities: u64,
    /// Live facts, all perspectives.
    pub facts: u64,
    /// Live assertions.
    pub assertions: u64,
    /// Physical rows incl. reverse runs (one row = one assertion).
    pub rows: u64,
}

/// Growth oracle vs the §6.2/§6.3 expectations (E6: measured, not asserted).
#[derive(Debug, Clone, Serialize)]
pub struct GrowthJson {
    /// Input records (nodes + edges, post-dedup).
    pub input_records: u64,
    /// Live logical facts (main perspective — the §6.2 comparison basis).
    pub logical_facts_main: u64,
    /// Live logical facts including audit (conflict/5).
    pub logical_facts_total: u64,
    /// logical_facts_main / input_records.
    pub count_growth_factor: f64,
    /// Doc §6.2 variant-A expectation.
    pub doc_variant_a_facts: u64,
    /// Doc §6.3 A″ span-collapse expectation.
    pub doc_span_collapse_facts: u64,
    /// Physical rows incl. reverse runs.
    pub physical_rows: u64,
    /// Doc §6.3 A+R physical-row expectation.
    pub doc_rows_variant_a_reverse: u64,
    /// Output bytes (store dir).
    pub output_bytes: u64,
    /// §6.1 live input bytes (the byte-band denominator).
    pub doc_input_live_bytes: u64,
    /// output_bytes / doc_input_live_bytes.
    pub byte_growth_factor: f64,
    /// The §6.3 honest byte band.
    pub doc_byte_band: String,
}

/// Conflict section of the report (C7).
#[derive(Debug, Clone, Serialize)]
pub struct ConflictsJson {
    /// Total conflict/5 facts (C7's «≥39» target).
    pub total: u64,
    /// Per-predicate summaries.
    pub per_predicate: BTreeMap<String, ConflictSummary>,
    /// Multi-live `type` subjects cross-checked against the base-five
    /// resolver (DEV-P6-1) — equals the type conflict count.
    pub type_cross_checked_subjects: u64,
}

/// The full conversion report (C7: every number, no «успешно» without them).
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// Report schema tag.
    pub schema: String,
    /// Input section.
    pub input: InputJson,
    /// Output section.
    pub output: OutputJson,
    /// §10.1 $legacy/tick-0 counters.
    pub legacy: LegacyCounters,
    /// Author pollution (Q4).
    pub pollution: PollutionCounters,
    /// Enumeration/dedup counters (S1/S2/S8).
    pub load: LoadCounters,
    /// Decomposition counters (S4/S5/S6, Q6, step 4).
    pub decompose: DecomposeCounters,
    /// Retyped total (step 4; expected 20,709 on the real base).
    pub retyped_total: u64,
    /// Conflict/5 (duty 5).
    pub conflicts: ConflictsJson,
    /// §9.4 metrics.
    pub metrics: MetricsJson,
    /// Growth oracle (E6).
    pub growth: GrowthJson,
    /// §9.1 canonical state sha (hex BLAKE3), reader-computed.
    pub canonical_state_sha: String,
    /// C1 verification summary (when `--verify-c1`).
    pub c1: Option<reader::C1Summary>,
    /// Wallclock of the whole run in seconds (report-only; the report is NOT
    /// part of the output-dir byte-identity gate).
    pub wallclock_seconds: f64,
}

// ── Orchestration (the CLI entry) ──────────────────────────────────

/// CLI options of `rofl-convert`.
#[derive(Debug, Clone)]
pub struct RunOptions {
    /// The old base (READ-ONLY).
    pub input: PathBuf,
    /// The fresh output directory (must not exist).
    pub output: PathBuf,
    /// Run the C1 record-level round-trip verification after conversion.
    pub verify_c1: bool,
}

/// The full §10.3 conversion, duties 1-6 in order.
pub fn run(opts: &RunOptions) -> Result<Report, ConvertError> {
    let t0 = std::time::Instant::now();
    // Duty 1: preflight + read-only contract.
    let pf = preflight(&opts.input)?;
    let (sha_before, input_size) = dir_recursive_sha256(&opts.input)?;
    if opts.output.exists() {
        return Err(cerr(
            "E-CONV-OUTPUT",
            format!(
                "output {} already exists — the converter only writes fresh directories",
                opts.output.display()
            ),
        ));
    }
    std::fs::create_dir(&opts.output)
        .map_err(|e| cerr("E-CONV-OUTPUT", format!("create {}: {e}", opts.output.display())))?;

    // Duties 2-5 (in memory), over one pinned snapshot of the input.
    let fs = LsmFactStore::open(&opts.input).map_err(|e| cerr("E-CONV-INPUT", e))?;
    let (nodes, edges, load) = load_input_from(&fs)?;
    let input_records = nodes.len() as u64 + edges.len() as u64;
    let conv = build_converted(&nodes, &edges, load, &fs)?;
    drop(nodes);
    drop(edges);
    drop(fs);

    // Physical write (F1/F2).
    let (segments, rows_total) = write_store(&conv, &opts.output, pf.shard_count)?;
    let segment_files = segments.len() as u64;
    let provenance = ProvenanceJson {
        input_path: opts.input.display().to_string(),
        input_recursive_sha256: sha_before.clone(),
        input_size_bytes: input_size,
        input_manifest_version: pf.manifest_version,
        converter: format!(
            "rfdb-{} git:{}",
            env!("CARGO_PKG_VERSION"),
            option_env!("ROFL_CONVERT_GIT_SHA").unwrap_or("unbaked")
        ),
    };
    let mut man = build_manifest(&conv, segments, pf.shard_count, provenance);

    // Duty 6: canonical_state_sha, computed by the READER over the WRITTEN
    // segments (not the in-memory state) — plus writer↔reader coherence.
    let store = reader::ConvertedStore::from_parts(opts.output.clone(), man.clone());
    let read_facts = store.load_facts().map_err(|e| cerr("E-CONV-VERIFY", e))?;
    let mem_facts = conv.facts.len() as u64;
    let mem_asserts: u64 = conv.facts.values().map(|f| f.asserts.len() as u64).sum();
    let read_count = read_facts.len() as u64;
    let read_asserts: u64 = read_facts.values().map(|(_, a)| a.len() as u64).sum();
    if (read_count, read_asserts) != (mem_facts, mem_asserts) {
        return Err(cerr(
            "E-CONV-VERIFY",
            format!(
                "writer/reader drift: {read_count} facts / {read_asserts} assertions read \
                 back vs {mem_facts} / {mem_asserts} converted"
            ),
        ));
    }
    store
        .verify_reverse_runs(&read_facts)
        .map_err(|e| cerr("E-CONV-VERIFY", e))?;
    let sha = reader::canonical_state_sha(&man, &read_facts);
    man.canonical_state_sha = sha.iter().map(|b| format!("{b:02x}")).collect();
    man.write_atomic(&opts.output)
        .map_err(|e| cerr("E-CONV-OUTPUT", format!("manifest write: {e}")))?;
    drop(store);
    drop(read_facts);

    // Metrics (reader-side numbers; entities = live sid facts).
    let sid_facts = man
        .catalog
        .iter()
        .find(|d| d.name == "sid")
        .map(|d| d.live_facts)
        .unwrap_or(0);
    let conflicts_total: u64 = conv.conflicts.values().map(|c| c.count).sum();
    let facts_main: u64 = man
        .catalog
        .iter()
        .filter(|d| d.name != "conflict")
        .map(|d| d.live_facts)
        .sum();
    let retyped_total: u64 = conv.decompose.retyped.values().sum();

    // C1 (optional): fully disk-driven — reloads BOTH sides from disk.
    let c1 = if opts.verify_c1 {
        let summary = reader::verify_c1(&opts.input, &opts.output)?;
        if !summary.full_multiset_equal || !summary.resolved_view_consistent {
            return Err(cerr(
                "E-CONV-VERIFY",
                format!(
                    "C1 round-trip failed: node_mismatches={} edge_mismatches={} \
                     exceptions={} consistent={}",
                    summary.node_mismatches,
                    summary.edge_mismatches,
                    summary.exceptions.len(),
                    summary.resolved_view_consistent
                ),
            ));
        }
        Some(summary)
    } else {
        None
    };

    // Read-only contract, asserted (D1).
    let (sha_after, _) = dir_recursive_sha256(&opts.input)?;
    if sha_after != sha_before {
        return Err(cerr(
            "E-CONV-IMMUTABLE",
            format!(
                "input changed during conversion: sha256 {sha_before} -> {sha_after} — the \
                 read-only contract is violated"
            ),
        ));
    }
    let (out_sha, out_bytes) = dir_recursive_sha256(&opts.output)?;

    let type_conflicts = conv
        .conflicts
        .get("type")
        .map(|c| c.count)
        .unwrap_or(0);
    Ok(Report {
        schema: "rofl-p6-stage1-report-v1".to_string(),
        input: InputJson {
            path: opts.input.display().to_string(),
            recursive_sha256: sha_before,
            recursive_sha256_after: sha_after,
            size_bytes: input_size,
            manifest_version: pf.manifest_version,
        },
        output: OutputJson {
            path: opts.output.display().to_string(),
            shard_count: pf.shard_count,
            recursive_sha256: out_sha,
            size_bytes: out_bytes,
            segment_files,
            predicates: man.catalog.len() as u64,
            authors: man.authors.len() as u64,
        },
        legacy: conv.legacy.clone(),
        pollution: conv.pollution.clone(),
        load: conv.load.clone(),
        decompose: conv.decompose.clone(),
        retyped_total,
        conflicts: ConflictsJson {
            total: conflicts_total,
            per_predicate: conv.conflicts.clone(),
            type_cross_checked_subjects: type_conflicts,
        },
        metrics: MetricsJson {
            entities: sid_facts,
            facts: facts_main + conflicts_total,
            assertions: mem_asserts,
            rows: rows_total,
        },
        growth: GrowthJson {
            input_records,
            logical_facts_main: facts_main,
            logical_facts_total: facts_main + conflicts_total,
            count_growth_factor: if input_records == 0 {
                0.0
            } else {
                facts_main as f64 / input_records as f64
            },
            doc_variant_a_facts: 5_889_638,
            doc_span_collapse_facts: 4_463_189,
            physical_rows: rows_total,
            doc_rows_variant_a_reverse: 9_011_248,
            output_bytes: out_bytes,
            doc_input_live_bytes: 227_698_510,
            byte_growth_factor: out_bytes as f64 / 227_698_510.0,
            doc_byte_band: "1.74x..3.11x".to_string(),
        },
        canonical_state_sha: man.canonical_state_sha.clone(),
        c1,
        wallclock_seconds: t0.elapsed().as_secs_f64(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── fixtures ───────────────────────────────────────────────────

    fn dc() -> DecomposeCounters {
        DecomposeCounters::default()
    }

    fn no_edge_types() -> HashSet<String> {
        HashSet::new()
    }

    fn jnum(n: serde_json::Number) -> serde_json::Value {
        serde_json::Value::Number(n)
    }

    fn meta_of(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        let mut m = serde_json::Map::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    fn term_of(v: &Value) -> (&str, usize) {
        match v {
            Value::Term(t) => (t.functor.as_str(), t.args.len()),
            other => panic!("expected a Term, got {other:?}"),
        }
    }

    // ── S4 / D4: metadata value typing ─────────────────────────────

    /// S4: every JSON shape maps to its declared canon variant — the mapping the
    /// reader inverts in `value_to_json_text`.
    #[test]
    fn s4_metadata_value_typing_covers_every_json_shape() {
        let mut c = dc();
        let v = |key: &str, j: serde_json::Value, c: &mut DecomposeCounters| -> Value {
            json_to_value(key, &j, c).expect("S4 typing never errors inside the envelope")
        };

        assert_eq!(
            v("k", serde_json::json!("text"), &mut c),
            Value::Str("text".into())
        );
        assert_eq!(v("k", serde_json::json!(42), &mut c), Value::Int(42));
        assert_eq!(v("k", serde_json::json!(-42), &mut c), Value::Int(-42));
        assert_eq!(v("k", serde_json::json!(0), &mut c), Value::Int(0));
        // i64::MAX stays Int (V1: BigInt must NOT hold an i64-representable value).
        assert_eq!(
            v("k", serde_json::json!(i64::MAX), &mut c),
            Value::Int(i64::MAX)
        );
        // u64 above i64::MAX must become BigInt, and must NOT be silently
        // demoted or turned into a lossy float.
        let big = v(
            "k",
            jnum(serde_json::Number::from(u64::MAX)),
            &mut c,
        );
        assert!(matches!(big, Value::BigInt(_)), "u64::MAX must be BigInt, got {big:?}");
        assert_eq!(
            big,
            Value::big_int_from_decimal("18446744073709551615").expect("canonical")
        );
        let just_above = v(
            "k",
            jnum(serde_json::Number::from(i64::MAX as u64 + 1)),
            &mut c,
        );
        assert!(
            matches!(just_above, Value::BigInt(_)),
            "i64::MAX+1 is the BigInt boundary, got {just_above:?}"
        );

        assert_eq!(v("k", serde_json::json!(1.5), &mut c), Value::Float(1.5));
        assert_eq!(term_of(&v("k", serde_json::json!(true), &mut c)), ("$true", 0));
        assert_eq!(term_of(&v("k", serde_json::json!(false), &mut c)), ("$false", 0));

        let nulls_before = c.null_values;
        assert_eq!(term_of(&v("k", serde_json::json!(null), &mut c)), ("$null", 0));
        assert_eq!(c.null_values, nulls_before + 1);

        let obj = v("k", serde_json::json!({"a": 1}), &mut c);
        assert_eq!(term_of(&obj), ("$json", 1));
        let arr = v("k", serde_json::json!([1, "x"]), &mut c);
        assert_eq!(term_of(&arr), ("$json", 1));
        assert_eq!(c.json_composite_values, 2, "object AND array counted");
        // The $json payload is re-parseable JSON text (what the reader relies on).
        let Value::Term(t) = &arr else { unreachable!() };
        let Value::Str(text) = &t.args[0] else {
            panic!("$json payload must be Str")
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(text).expect("round-trips"),
            serde_json::json!([1, "x"])
        );
    }

    /// D4/step 4: ONLY the three Adjacency keys retype decimal-u128 strings into
    /// `Value::Id`, and only when the decimal is CANONICAL (no leading zeros,
    /// no sign) — otherwise the value stays a Str and the miss is counted.
    #[test]
    fn d4_retyping_only_under_the_three_adjacency_keys_with_a_canonical_decimal_guard() {
        let mut c = dc();
        let id_text = "340282366920938463463374607431768211455"; // u128::MAX
        for key in RETYPED_PREDS {
            let v = json_to_value(key, &serde_json::json!(id_text), &mut c).expect("typed");
            assert_eq!(v, Value::Id(u128::MAX), "{key} must retype");
            assert_eq!(c.retyped.get(key), Some(&1), "{key} counted per predicate");
        }
        assert_eq!(c.retype_misses, 0);

        // A key NOT in the table keeps the string verbatim.
        let v = json_to_value("callee", &serde_json::json!(id_text), &mut c).expect("typed");
        assert_eq!(v, Value::Str(id_text.into()));
        assert_eq!(c.retyped.len(), RETYPED_PREDS.len(), "no new predicate counted");

        // Non-canonical decimals under a retyped key: leading zero, sign,
        // overflow, non-numeric — each a counted MISS that stays a Str.
        let mut misses = 0;
        for bad in ["0123", "+1", "-1", "1e3", "", " 12", "12 ", "3402823669209384634633746074317682114550"] {
            let v = json_to_value("source_node", &serde_json::json!(bad), &mut c).expect("typed");
            assert_eq!(v, Value::Str(bad.into()), "{bad} must NOT retype");
            misses += 1;
        }
        assert_eq!(c.retype_misses, misses);
        assert_eq!(c.retyped.get("source_node"), Some(&1), "misses do not inflate the retyped count");

        // "0" IS canonical decimal and retypes to Id(0).
        let v = json_to_value("source_node", &serde_json::json!("0"), &mut c).expect("typed");
        assert_eq!(v, Value::Id(0));

        // A NON-string value under a retyped key falls through to plain S4.
        let v = json_to_value("source_node", &serde_json::json!(7), &mut c).expect("typed");
        assert_eq!(v, Value::Int(7));
    }

    // ── S5 / S6: blob copies and the collision guard ───────────────

    /// S5: metadata copies of the column-authoritative keys emit NO fact; the
    /// skip is counted, and a copy DIFFERING from the column is counted again.
    #[test]
    fn s5_blob_copies_of_column_authoritative_keys_are_skipped_and_counted() {
        let mut c = dc();
        let mut facts = Vec::new();
        let meta = meta_of(&[
            ("name", serde_json::json!("fn1")),          // == column
            ("file", serde_json::json!("a/f.js")),       // == column
            ("semantic_id", serde_json::json!("OTHER")), // DIFFERS
            ("kept", serde_json::json!("yes")),
        ]);
        decompose_meta(
            11,
            &meta,
            "analyzer",
            3,
            &no_edge_types(),
            Some(("fn1", "a/f.js", "a/f.js->FUNCTION->fn1")),
            &mut facts,
            &mut c,
        )
        .expect("decomposes");

        assert_eq!(c.blob_copies_skipped, 3, "all three column keys skipped");
        assert_eq!(c.blob_copies_differing, 1, "only semantic_id differs");
        assert_eq!(facts.len(), 1, "only the non-column key emits a fact");
        assert_eq!(facts[0].pred, "kept");

        // Edge subjects pass column_check = None, so the SAME keys DO emit facts
        // (edges have no name/file/semantic_id columns to be authoritative).
        let mut c2 = dc();
        let mut efacts = Vec::new();
        decompose_meta(99, &meta, "analyzer", 3, &no_edge_types(), None, &mut efacts, &mut c2)
            .expect("decomposes");
        assert_eq!(c2.blob_copies_skipped, 0);
        assert_eq!(efacts.len(), 4, "edge metadata keeps all four keys");
    }

    /// S6: a metadata key colliding with a CORE_RESERVED name, with an
    /// edge_type name, or with the guard prefix itself gets `$meta:`-prefixed —
    /// and the reader's `strip_prefix` inverts it exactly once.
    #[test]
    fn s6_collision_guard_prefixes_reserved_and_edge_type_keys() {
        let mut edge_types = HashSet::new();
        edge_types.insert("CALLS".to_string());
        let mut c = dc();

        for reserved in CORE_RESERVED {
            let mut cc = dc();
            assert_eq!(
                guard_meta_key(reserved, &edge_types, &mut cc),
                format!("{META_PREFIX}{reserved}"),
                "core-reserved '{reserved}' must be guarded"
            );
            assert_eq!(cc.meta_prefixed_keys, 1);
        }
        assert_eq!(guard_meta_key("type", &edge_types, &mut c), "$meta:type");
        assert_eq!(guard_meta_key("CALLS", &edge_types, &mut c), "$meta:CALLS");
        assert_eq!(
            guard_meta_key("$meta:x", &edge_types, &mut c),
            "$meta:$meta:x",
            "the prefix itself is guarded, so stripping is unambiguous"
        );
        assert_eq!(c.meta_prefixed_keys, 3);

        // A key colliding with NOTHING is untouched (and not counted).
        assert_eq!(guard_meta_key("async", &edge_types, &mut c), "async");
        assert_eq!(guard_meta_key("CALLED_BY", &edge_types, &mut c), "CALLED_BY");
        assert_eq!(c.meta_prefixed_keys, 3);

        // The reader's inverse: ONE strip recovers the original key each time.
        for original in ["type", "CALLS", "$meta:x", "sid", "span", "conflict"] {
            let guarded = guard_meta_key(original, &edge_types, &mut dc());
            assert_eq!(
                guarded.strip_prefix(META_PREFIX).unwrap_or(&guarded),
                original,
                "strip_prefix must invert the guard for '{original}'"
            );
        }
        // Untouched keys survive the same inverse unchanged.
        assert_eq!("async".strip_prefix(META_PREFIX).unwrap_or("async"), "async");

        // End-to-end through decompose_meta: the guarded predicate name is what
        // lands in the fact.
        let mut c3 = dc();
        let mut facts = Vec::new();
        decompose_meta(
            7,
            &meta_of(&[("type", serde_json::json!("shadow")), ("CALLS", serde_json::json!(1))]),
            "a",
            1,
            &edge_types,
            None,
            &mut facts,
            &mut c3,
        )
        .expect("decomposes");
        let mut preds: Vec<&str> = facts.iter().map(|f| f.pred.as_str()).collect();
        preds.sort_unstable();
        assert_eq!(preds, vec!["$meta:CALLS", "$meta:type"]);
        assert_eq!(c3.meta_prefixed_keys, 2);
    }

    // ── Q6: the A″ span collapse ───────────────────────────────────

    /// Q6: all four SPAN_KEYS present as i64 collapse into ONE span/5 fact whose
    /// columns are the four keys IN SPAN_KEYS ORDER — and the per-key facts are
    /// gone.
    #[test]
    fn q6_full_span_collapses_into_one_span5_fact() {
        let mut c = dc();
        let mut facts = Vec::new();
        decompose_meta(
            11,
            &meta_of(&[
                ("endColumn", serde_json::json!(40)),
                ("line", serde_json::json!(5)),
                ("column", serde_json::json!(0)),
                ("endLine", serde_json::json!(9)),
                ("async", serde_json::json!(true)),
            ]),
            "analyzer",
            3,
            &no_edge_types(),
            None,
            &mut facts,
            &mut c,
        )
        .expect("decomposes");

        assert_eq!(c.span_facts, 1);
        assert_eq!(c.partial_span_subjects, 0);
        let span: Vec<&ProtoFact> = facts.iter().filter(|f| f.pred == "span").collect();
        assert_eq!(span.len(), 1, "exactly one span fact");
        assert_eq!(
            span[0].tuple,
            vec![
                Value::Id(11),
                Value::Int(5),  // line
                Value::Int(0),  // column — `column: 0` must NOT be treated as absent
                Value::Int(9),  // endLine
                Value::Int(40), // endColumn
            ],
            "columns follow SPAN_KEYS order, not metadata insertion order"
        );
        assert_eq!(span[0].persp, PERSP_MAIN);
        // No per-key facts survive; the unrelated key does.
        let others: Vec<&str> = facts
            .iter()
            .filter(|f| f.pred != "span")
            .map(|f| f.pred.as_str())
            .collect();
        assert_eq!(others, vec!["async"]);

        // Round-trip back to four keys, exactly as reader.rs::reassemble does.
        let mut back: Vec<(String, i64)> = Vec::new();
        for (i, key) in SPAN_KEYS.iter().enumerate() {
            let Value::Int(x) = span[0].tuple[i + 1] else {
                panic!("span column {i} is not Int")
            };
            back.push(((*key).to_string(), x));
        }
        back.sort();
        assert_eq!(
            back,
            vec![
                ("column".to_string(), 0),
                ("endColumn".to_string(), 40),
                ("endLine".to_string(), 9),
                ("line".to_string(), 5),
            ]
        );
    }

    /// Q6 negative: a PARTIAL span (or a span key that is not an i64) stays as
    /// per-key facts, is counted, and emits NO span/5.
    #[test]
    fn q6_partial_span_stays_per_key_and_does_not_collapse() {
        // Three of four keys.
        let mut c = dc();
        let mut facts = Vec::new();
        decompose_meta(
            12,
            &meta_of(&[
                ("line", serde_json::json!(5)),
                ("column", serde_json::json!(0)),
                ("endLine", serde_json::json!(9)),
            ]),
            "analyzer",
            3,
            &no_edge_types(),
            None,
            &mut facts,
            &mut c,
        )
        .expect("decomposes");
        assert_eq!(c.span_facts, 0, "a partial span must NOT collapse");
        assert_eq!(c.partial_span_subjects, 1);
        let mut preds: Vec<&str> = facts.iter().map(|f| f.pred.as_str()).collect();
        preds.sort_unstable();
        assert_eq!(preds, vec!["column", "endLine", "line"]);
        assert!(facts.iter().all(|f| f.tuple.len() == 2));

        // All four keys present but one is NOT an i64 → still no collapse, and
        // the non-integer value survives as its own S4-typed fact.
        let mut c2 = dc();
        let mut facts2 = Vec::new();
        decompose_meta(
            13,
            &meta_of(&[
                ("line", serde_json::json!(5)),
                ("column", serde_json::json!(0)),
                ("endLine", serde_json::json!(9)),
                ("endColumn", serde_json::json!("40")),
            ]),
            "analyzer",
            3,
            &no_edge_types(),
            None,
            &mut facts2,
            &mut c2,
        )
        .expect("decomposes");
        assert_eq!(c2.span_facts, 0);
        assert_eq!(c2.partial_span_subjects, 1);
        assert_eq!(facts2.len(), 4);
        let end_col = facts2.iter().find(|f| f.pred == "endColumn").expect("kept");
        assert_eq!(end_col.tuple[1], Value::Str("40".into()));

        // No span keys at all → neither counter moves.
        let mut c3 = dc();
        let mut facts3 = Vec::new();
        decompose_meta(
            14,
            &meta_of(&[("async", serde_json::json!(true))]),
            "a",
            1,
            &no_edge_types(),
            None,
            &mut facts3,
            &mut c3,
        )
        .expect("decomposes");
        assert_eq!((c3.span_facts, c3.partial_span_subjects), (0, 0));
    }

    // ── D5 / R-1a: functional resolution ───────────────────────────

    /// Author ids mirror the REAL shortlex ranks: `haskell-local-refs` (18
    /// chars) ranks BEFORE `haskell-runtime-globals` (23), so the low-priority
    /// author owns the SMALLER id — which is exactly what makes F2 falsifiable
    /// against F3.
    const A_LOW: u32 = 3; // SEEDED_PRIORITY_LOW
    const A_HIGH: u32 = 7; // SEEDED_PRIORITY_HIGH
    const A_OTHER: u32 = 1; // an unlisted author with an even smaller id

    fn cfact(value: &str, asserts: &[(u32, u64)]) -> ConvFact {
        ConvFact {
            persp: PERSP_MAIN,
            pred: 0,
            tuple: vec![Value::Id(30), Value::Str(value.into())],
            asserts: asserts.iter().copied().collect(),
        }
    }

    fn seeded_priority() -> Vec<u32> {
        vec![A_HIGH, A_LOW]
    }

    fn fids_of(group: &[&ConvFact]) -> Vec<u128> {
        group
            .iter()
            .map(|f| fid(PERSPECTIVE_MAIN_NAME, "type", &f.tuple).expect("canonical"))
            .collect()
    }

    #[test]
    fn r1a_f1_max_tick_wins_over_a_higher_priority_author() {
        let a = cfact("GLOBAL_DEFINITION", &[(A_HIGH, 1)]);
        let b = cfact("EXTERNAL_FUNCTION", &[(A_LOW, 2)]);
        let group = vec![&a, &b];
        let fids = fids_of(&group);
        let r = resolve_r1a(&group, &fids, &seeded_priority());
        assert_eq!(r.winner_idx, 1, "tick 2 beats the priority author's tick 1");
        assert_eq!(r.winner_author, A_LOW);
        assert_eq!(r.winner_tick, 2);

        // Symmetric: give the HIGH author the newer tick and it wins for the
        // freshness reason, not the priority reason.
        let a = cfact("GLOBAL_DEFINITION", &[(A_HIGH, 5)]);
        let b = cfact("EXTERNAL_FUNCTION", &[(A_LOW, 4)]);
        let group = vec![&a, &b];
        let fids = fids_of(&group);
        let r = resolve_r1a(&group, &fids, &seeded_priority());
        assert_eq!((r.winner_idx, r.winner_tick), (0, 5));

        // One fact can carry several assertions; the max tick across ALL of them
        // is what F1 filters on.
        let a = cfact("GLOBAL_DEFINITION", &[(A_HIGH, 1), (A_HIGH, 9)]);
        let b = cfact("EXTERNAL_FUNCTION", &[(A_LOW, 8)]);
        let group = vec![&a, &b];
        let fids = fids_of(&group);
        let r = resolve_r1a(&group, &fids, &seeded_priority());
        assert_eq!((r.winner_idx, r.winner_tick), (0, 9));
    }

    #[test]
    fn r1a_f2_seeded_priority_decides_a_tick_tie_against_canon_order() {
        let a = cfact("GLOBAL_DEFINITION", &[(A_HIGH, 1)]);
        let b = cfact("EXTERNAL_FUNCTION", &[(A_LOW, 1)]);
        let group = vec![&a, &b];
        let fids = fids_of(&group);

        let r = resolve_r1a(&group, &fids, &seeded_priority());
        assert_eq!(
            (r.winner_idx, r.winner_author),
            (0, A_HIGH),
            "the seeded pair decides the tie"
        );

        // The falsifier: with an EMPTY table the SAME input flips to F3 author
        // canon-order, which picks the smaller id (the LOW-priority author).
        let r0 = resolve_r1a(&group, &fids, &[]);
        assert_eq!(
            (r0.winner_idx, r0.winner_author),
            (1, A_LOW),
            "empty table degenerates to canon-order — F2 really is what decides"
        );
        assert_eq!(r.winner_tick, r0.winner_tick, "F1 already agreed");
    }

    #[test]
    fn r1a_f2_is_skipped_when_a_survivor_author_is_not_in_the_priority_table() {
        // Unlisted-vs-listed is UNDECIDED by the table (no "listed beats
        // everyone"): F2 is skipped entirely and F3 picks the smaller author id,
        // which here belongs to the UNLISTED author.
        let a = cfact("GLOBAL_DEFINITION", &[(A_HIGH, 1)]);
        let b = cfact("OTHER_TYPE", &[(A_OTHER, 1)]);
        let group = vec![&a, &b];
        let fids = fids_of(&group);
        let r = resolve_r1a(&group, &fids, &seeded_priority());
        assert_eq!(
            (r.winner_idx, r.winner_author),
            (1, A_OTHER),
            "an unlisted author is not outranked by a listed one"
        );

        // "not all one rank": both survivors are the SAME listed author, so the
        // table cannot separate them and F4 (min fid) decides.
        let a = cfact("AAA", &[(A_HIGH, 1)]);
        let b = cfact("BBB", &[(A_HIGH, 1)]);
        let group = vec![&a, &b];
        let fids = fids_of(&group);
        let r = resolve_r1a(&group, &fids, &seeded_priority());
        let expected = if fids[0] < fids[1] { 0 } else { 1 };
        assert_eq!(r.winner_idx, expected, "same rank → fall through to min fid");
        assert_eq!(r.winner_author, A_HIGH);
    }

    #[test]
    fn r1a_f4_min_fid_breaks_a_full_tie() {
        // Same author, same tick, three distinct values: only the fid separates
        // them, and the result is independent of the input ORDER (determinism).
        let a = cfact("AAA", &[(A_LOW, 4)]);
        let b = cfact("BBB", &[(A_LOW, 4)]);
        let c = cfact("CCC", &[(A_LOW, 4)]);
        let group = vec![&a, &b, &c];
        let fids = fids_of(&group);
        let r = resolve_r1a(&group, &fids, &seeded_priority());
        let min_pos = (0..3).min_by_key(|&i| fids[i]).expect("non-empty");
        assert_eq!(r.winner_idx, min_pos);
        assert_eq!((r.winner_author, r.winner_tick), (A_LOW, 4));

        let rev_group = vec![&c, &b, &a];
        let rev_fids = fids_of(&rev_group);
        let r2 = resolve_r1a(&rev_group, &rev_fids, &seeded_priority());
        assert_eq!(
            rev_group[r2.winner_idx].tuple[1], group[r.winner_idx].tuple[1],
            "min-fid is order-independent"
        );
        // Distinct facts really do have distinct fids (F4 is total).
        let mut sorted = fids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 3);
    }

    // ── D5 end-to-end: conflict/5 emission + losers stay live ──────

    fn node_rec_at(
        id: u128,
        ty: &str,
        name: &str,
        file: &str,
        sid: &str,
        meta: &str,
    ) -> NodeRecordV2 {
        NodeRecordV2 {
            semantic_id: sid.to_string(),
            id,
            node_type: ty.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: meta.to_string(),
        }
    }

    fn prov(source: &str, generation: u64) -> String {
        serde_json::json!({"_source": source, "_generation": generation}).to_string()
    }

    /// D5/Q10: EVERY multi-live resolution emits a conflict/5 per loser into the
    /// `audit` perspective, and the LOSER assertion STAYS LIVE in `main` —
    /// stage 1 supersedes nothing.
    #[test]
    fn d5_conflict5_emitted_for_every_loser_and_losers_stay_live() {
        let fs = LsmFactStore::ephemeral(2);
        // Subject 30: a TICK TIE decided by the seeded pair.
        fs.commit_legacy(
            vec![node_rec_at(
                30,
                "GLOBAL_DEFINITION",
                "g",
                "a.hs",
                "a.hs->g",
                &prov(SEEDED_PRIORITY_HIGH, 1),
            )],
            vec![],
            &[],
        );
        fs.commit_legacy(
            vec![node_rec_at(
                30,
                "EXTERNAL_FUNCTION",
                "g",
                "a.hs",
                "a.hs->g",
                &prov(SEEDED_PRIORITY_LOW, 1),
            )],
            vec![],
            &[],
        );
        // Subject 31: three records, distinct ticks — max tick wins, TWO losers.
        for (ty, tick) in [("A_TYPE", 5u64), ("B_TYPE", 6), ("C_TYPE", 9)] {
            fs.commit_legacy(
                vec![node_rec_at(31, ty, "h", "b.hs", "b.hs->h", &prov("analyzer", tick))],
                vec![],
                &[],
            );
        }
        // Subject 32: a single record — no conflict at all.
        fs.commit_legacy(
            vec![node_rec_at(32, "SOLO", "s", "c.hs", "c.hs->s", &prov("analyzer", 2))],
            vec![],
            &[],
        );

        let (nodes, edges, load) = load_input_from(&fs).expect("load");
        assert_eq!(load.distinct_node_ids, 3);
        assert_eq!(load.multi_record_node_ids, 2, "subjects 30 and 31");
        let conv = build_converted(&nodes, &edges, load, &fs).expect("convert");

        // One conflict per LOSER: 1 (subject 30) + 2 (subject 31).
        let type_conflicts = conv.conflicts.get("type").expect("type summarized");
        assert_eq!(type_conflicts.count, 3);
        assert_eq!(
            type_conflicts.winner_values.get("GLOBAL_DEFINITION"),
            Some(&1),
            "the seeded HIGH author wins the tie"
        );
        assert_eq!(type_conflicts.winner_values.get("C_TYPE"), Some(&2));
        assert_eq!(type_conflicts.loser_values.get("EXTERNAL_FUNCTION"), Some(&1));
        assert_eq!(type_conflicts.loser_values.get("A_TYPE"), Some(&1));
        assert_eq!(type_conflicts.loser_values.get("B_TYPE"), Some(&1));
        assert_eq!(
            type_conflicts.winner_authors.get(SEEDED_PRIORITY_HIGH),
            Some(&1)
        );
        // name/file/sid were IDENTICAL across the versions, so those Functional
        // predicates have exactly one fact each — no conflict.
        for pred in ["name", "file", "sid"] {
            assert_eq!(
                conv.conflicts.get(pred).map(|c| c.count),
                Some(0),
                "{pred} must not conflict"
            );
        }

        let pid = |name: &str| -> u32 {
            conv.pred_names
                .iter()
                .position(|n| n == name)
                .expect("declared") as u32
        };
        let type_id = pid("type");
        let conflict_id = pid("conflict");

        // Q10: losers STAY LIVE — every original type value is still a fact.
        let live_types = |subject: u128| -> BTreeSet<String> {
            conv.facts
                .values()
                .filter(|f| f.pred == type_id && f.persp == PERSP_MAIN)
                .filter(|f| matches!(f.tuple[0], Value::Id(s) if s == subject))
                .map(|f| match &f.tuple[1] {
                    Value::Str(s) => s.clone(),
                    other => panic!("type value {other:?}"),
                })
                .collect()
        };
        assert_eq!(
            live_types(30),
            ["EXTERNAL_FUNCTION", "GLOBAL_DEFINITION"]
                .iter()
                .map(|s| s.to_string())
                .collect::<BTreeSet<_>>()
        );
        assert_eq!(live_types(31).len(), 3, "all three type facts stay live");
        assert_eq!(live_types(32).len(), 1);

        // The conflict/5 facts: audit perspective, converter author, winner
        // tick, and the OQ-1/OQ-2 column shape.
        let convert_author = conv
            .author_names
            .iter()
            .position(|a| a == CONVERT_AUTHOR)
            .expect("interned") as u32;
        let conflicts: Vec<&ConvFact> = conv
            .facts
            .values()
            .filter(|f| f.pred == conflict_id)
            .collect();
        assert_eq!(conflicts.len(), 3);
        for f in &conflicts {
            assert_eq!(f.persp, PERSP_AUDIT, "conflicts are durable in `audit`");
            assert_eq!(f.tuple.len(), 5);
            assert!(matches!(f.tuple[0], Value::Id(_)));
            assert_eq!(f.tuple[1], Value::Str("type".into()));
            assert!(matches!(f.tuple[2], Value::Id(_)));
            assert!(matches!(f.tuple[3], Value::Id(_)));
            assert_ne!(f.tuple[2], f.tuple[3], "winner fid != loser fid");
            assert!(matches!(f.tuple[4], Value::Int(_)));
            assert_eq!(f.asserts.len(), 1);
            let &(author, _) = f.asserts.iter().next().expect("one assertion");
            assert_eq!(author, convert_author);
        }
        // Winner tick column: 1 for subject 30 (the tie), 9 for subject 31.
        let mut by_subject: BTreeMap<u128, Vec<i64>> = BTreeMap::new();
        for f in &conflicts {
            let Value::Id(s) = f.tuple[0] else { unreachable!() };
            let Value::Int(t) = f.tuple[4] else { unreachable!() };
            by_subject.entry(s).or_default().push(t);
            let &(_, tick) = f.asserts.iter().next().expect("one assertion");
            assert_eq!(tick as i64, t, "assertion tick == winner tick column");
        }
        assert_eq!(by_subject.get(&30), Some(&vec![1]));
        assert_eq!(by_subject.get(&31).map(|v| v.len()), Some(2));
        assert!(by_subject[&31].iter().all(|&t| t == 9));
        assert!(!by_subject.contains_key(&32), "no conflict for a single record");

        // The winner fid really is the winning fact's fid (the reader's join
        // column) — and the loser fid is the loser's.
        let fid_of = |ty: &str, subject: u128| -> u128 {
            fid(
                PERSPECTIVE_MAIN_NAME,
                "type",
                &[Value::Id(subject), Value::Str(ty.into())],
            )
            .expect("canonical")
        };
        let c30 = conflicts
            .iter()
            .find(|f| matches!(f.tuple[0], Value::Id(30)))
            .expect("subject 30 conflict");
        assert_eq!(c30.tuple[2], Value::Id(fid_of("GLOBAL_DEFINITION", 30)));
        assert_eq!(c30.tuple[3], Value::Id(fid_of("EXTERNAL_FUNCTION", 30)));
    }

    // ── D3 / S8: provenance tolerance ──────────────────────────────

    /// S8: `_generation` parses as a u64 NUMBER and as a u64-numeric STRING;
    /// anything else is tick 0 + a counter. A non-string `_source` is `$legacy`
    /// + a counter. Absent keys move NO counter.
    #[test]
    fn s8_provenance_tolerance_number_string_and_the_counted_rejects() {
        let mut c = LoadCounters::default();

        // Number form.
        let (a, t, hs, hg) = provenance_of(
            &meta_of(&[
                ("_source", serde_json::json!("analyzer")),
                ("_generation", serde_json::json!(42)),
            ]),
            &mut c,
        );
        assert_eq!((a.as_str(), t, hs, hg), ("analyzer", 42, true, true));

        // String form — same tick.
        let (a, t, hs, hg) = provenance_of(
            &meta_of(&[
                ("_source", serde_json::json!("analyzer")),
                ("_generation", serde_json::json!("42")),
            ]),
            &mut c,
        );
        assert_eq!((a.as_str(), t, hs, hg), ("analyzer", 42, true, true));

        // u64::MAX in both forms (beyond i64 — must not clamp or wrap).
        let (_, t, _, _) = provenance_of(
            &meta_of(&[("_generation", jnum(serde_json::Number::from(u64::MAX)))]),
            &mut c,
        );
        assert_eq!(t, u64::MAX);
        let (_, t, _, _) = provenance_of(
            &meta_of(&[("_generation", serde_json::json!("18446744073709551615"))]),
            &mut c,
        );
        assert_eq!(t, u64::MAX);
        assert_eq!(c.unparseable_generation, 0, "nothing rejected so far");
        assert_eq!(c.non_string_source, 0);

        // Absent keys: `$legacy` + tick 0, and NO counter moves.
        let (a, t, hs, hg) = provenance_of(&meta_of(&[]), &mut c);
        assert_eq!((a.as_str(), t, hs, hg), (LEGACY_AUTHOR, 0, false, false));
        assert_eq!((c.unparseable_generation, c.non_string_source), (0, 0));

        // Explicit `_generation: 0` gives tick 0 too — indistinguishable from
        // absent on the value axis (which is why the reader can round-trip tick
        // 0 as an OMITTED `_generation`), but `had_generation` still records the
        // difference.
        let (_, t, _, hg) = provenance_of(&meta_of(&[("_generation", serde_json::json!(0))]), &mut c);
        assert_eq!((t, hg), (0, true));

        // Every rejected `_generation` shape: tick 0, had_generation false, +1.
        let mut rejected = 0u64;
        for bad in [
            serde_json::json!("not-a-number"),
            serde_json::json!(-5),
            serde_json::json!(1.5),
            serde_json::json!(true),
            serde_json::json!(null),
            serde_json::json!({"v": 1}),
            serde_json::json!([1]),
            serde_json::json!(""),
            serde_json::json!("18446744073709551616"), // u64::MAX + 1
        ] {
            let (_, t, _, hg) = provenance_of(&meta_of(&[("_generation", bad.clone())]), &mut c);
            assert_eq!((t, hg), (0, false), "rejected shape {bad} must give tick 0");
            rejected += 1;
            assert_eq!(c.unparseable_generation, rejected);
        }

        // Every non-string `_source`: `$legacy`, had_source false, +1.
        let mut non_string = 0u64;
        for bad in [
            serde_json::json!(7),
            serde_json::json!(true),
            serde_json::json!(null),
            serde_json::json!({"n": "x"}),
            serde_json::json!(["x"]),
        ] {
            let (a, _, hs, _) = provenance_of(&meta_of(&[("_source", bad.clone())]), &mut c);
            assert_eq!((a.as_str(), hs), (LEGACY_AUTHOR, false), "shape {bad}");
            non_string += 1;
            assert_eq!(c.non_string_source, non_string);
        }
        // An EMPTY string `_source` is still a string — carried verbatim, not
        // counted as pollution.
        let (a, _, hs, _) = provenance_of(&meta_of(&[("_source", serde_json::json!(""))]), &mut c);
        assert_eq!((a.as_str(), hs), ("", true));
        assert_eq!(c.non_string_source, non_string);
    }
}
