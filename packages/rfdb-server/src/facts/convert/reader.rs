//! The converted store's verification READER (P6 stage 1; round-012-pre Q3).
//!
//! Implements the FactStore READ SUBSET over the new per-predicate layout:
//! live-fact enumeration from the forward runs, reverse-run permutation
//! verification, the §9.1 canonical state sha, and the C1 record-level
//! round-trip (reassembly + multiset comparison + the conflict/5-joined
//! exception set). Explicitly NOT an engine: no query surface, no write path.
//! It is the seed of the stage-2 native facts backend (§8), not throwaway code.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::datalog::Value;
use crate::derive::canon::push_varint;
use crate::derive::tag::TagV2;
use crate::facts::{fact_key_canon_bytes, fid, PERSPECTIVE_MAIN_NAME};
use crate::storage_v2::types::BOOLTAG_SEMIRING_ID;

use super::manifest::RoflManifest;
use super::segment::{decode_segment, DIR_FWD, DIR_REV};
use super::{cerr, tuple_canon, ConvertError, EdgeIn, NodeIn, META_PREFIX, SPAN_KEYS};

/// The reader's fact map: (pred id, persp id, tuple canon bytes) →
/// (tuple, assertions as (author id, tick)).
pub type FactMap = BTreeMap<(u32, u32, Vec<u8>), (Vec<Value>, BTreeSet<(u32, u64)>)>;

/// A converted store opened for verification reads.
pub struct ConvertedStore {
    /// Store root.
    pub root: PathBuf,
    /// The parsed manifest.
    pub manifest: RoflManifest,
}

impl ConvertedStore {
    /// Open from disk (reads + validates `rofl_manifest.json`).
    pub fn open(root: &Path) -> Result<Self, String> {
        let manifest = RoflManifest::read(root)?;
        for (i, decl) in manifest.catalog.iter().enumerate() {
            if decl.id != i as u32 {
                return Err(format!(
                    "catalog id {} at position {i} — ids must be dense shortlex ranks",
                    decl.id
                ));
            }
            if decl.columns.len() != decl.arity as usize {
                return Err(format!(
                    "predicate '{}' declares arity {} but names {} columns",
                    decl.name,
                    decl.arity,
                    decl.columns.len()
                ));
            }
        }
        // The AUTHOR table's shortlex order is load-bearing, not cosmetic: R-1a
        // F3 compares authors by NAME in shortlex order, and both the converter
        // and this reader compare interned author IDS instead — which is only
        // the same relation while id == shortlex rank. A store whose table is
        // out of order would silently resolve Functional conflicts differently
        // from the base. Same argument for perspectives (§9.2 ordering).
        for (label, table) in [
            ("author", &manifest.authors),
            ("perspective", &manifest.perspectives),
        ] {
            for w in table.windows(2) {
                if super::segment::canon_str_cmp(&w[0], &w[1]) != std::cmp::Ordering::Less {
                    return Err(format!(
                        "{label} table is not in strict shortlex order: '{}' precedes '{}' — \
                         interned ids would stop being canonical ranks",
                        w[0], w[1]
                    ));
                }
            }
        }
        Ok(Self {
            root: root.to_path_buf(),
            manifest,
        })
    }

    /// Wrap an in-memory manifest over written segments (the converter's own
    /// pre-publish verification path).
    pub fn from_parts(root: PathBuf, manifest: RoflManifest) -> Self {
        Self { root, manifest }
    }

    fn load_run(&self, direction: u8) -> Result<FactMap, String> {
        let dir_name = if direction == DIR_FWD { "fwd" } else { "rev" };
        let mut map: FactMap = BTreeMap::new();
        for desc in &self.manifest.segments {
            if desc.direction != dir_name {
                continue;
            }
            let path = self.root.join(&desc.path);
            let bytes =
                std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
            // INTEGRITY: the manifest's per-segment sha256 is the only thing that
            // makes the descriptor a commitment rather than a comment. Digest the
            // exact buffer we are about to decode (never a second read of the
            // path), and check the declared byte length too — a truncation that
            // preserved a prefix hash would otherwise pass.
            if bytes.len() as u64 != desc.bytes {
                return Err(format!(
                    "segment length drift at {}: {} bytes on disk vs {} in descriptor",
                    desc.path,
                    bytes.len(),
                    desc.bytes
                ));
            }
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let digest: String = hasher
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            if digest != desc.sha256 {
                return Err(format!(
                    "segment sha256 drift at {}: {digest} on disk vs {} in descriptor",
                    desc.path, desc.sha256
                ));
            }
            let seg = decode_segment(&bytes, &desc.path).map_err(|e| e.to_string())?;
            let decl = self
                .manifest
                .catalog
                .get(desc.predicate as usize)
                .ok_or_else(|| format!("segment {} names undeclared predicate {}", desc.path, desc.predicate))?;
            if seg.arity != decl.arity {
                return Err(format!(
                    "arity drift at {}: segment declares {} columns, predicate '{}' declares {}",
                    desc.path, seg.arity, decl.name, decl.arity
                ));
            }
            if seg.pred_id != desc.predicate || seg.direction != direction {
                return Err(format!(
                    "descriptor/segment drift at {}: pred {} dir {} vs descriptor pred {} \
                     dir {dir_name}",
                    desc.path, seg.pred_id, seg.direction, desc.predicate
                ));
            }
            if seg.rows.len() as u64 != desc.rows {
                return Err(format!(
                    "row-count drift at {}: {} in file vs {} in descriptor",
                    desc.path,
                    seg.rows.len(),
                    desc.rows
                ));
            }
            for row in seg.rows {
                let key = (seg.pred_id, row.persp, tuple_canon(&row.tuple));
                let entry = map
                    .entry(key)
                    .or_insert_with(|| (row.tuple.clone(), BTreeSet::new()));
                if !entry.1.insert((row.author, row.tick)) {
                    return Err(format!(
                        "duplicate physical assertion in {} (author {}, tick {})",
                        desc.path, row.author, row.tick
                    ));
                }
            }
        }
        Ok(map)
    }

    /// Every live fact, from the FORWARD runs (stage 1: everything is live —
    /// nothing is superseded).
    pub fn load_facts(&self) -> Result<FactMap, String> {
        self.load_run(DIR_FWD)
    }

    /// §6.3: a reverse run is a full second copy of the SAME rows. Verify the
    /// rev-run fact multiset equals the fwd-run multiset for every predicate
    /// declaring a reverse, and that no other predicate has rev segments.
    pub fn verify_reverse_runs(&self, fwd: &FactMap) -> Result<(), String> {
        let rev = self.load_run(DIR_REV)?;
        let with_reverse: BTreeSet<u32> = self
            .manifest
            .catalog
            .iter()
            .filter(|d| d.reverse.is_some())
            .map(|d| d.id)
            .collect();
        for (key, (_, asserts)) in &rev {
            if !with_reverse.contains(&key.0) {
                return Err(format!(
                    "reverse segment rows for predicate {} which declares no reverse run",
                    self.manifest.catalog[key.0 as usize].name
                ));
            }
            match fwd.get(key) {
                Some((_, fwd_asserts)) if fwd_asserts == asserts => {}
                _ => {
                    return Err(format!(
                        "reverse run of predicate {} is not a permutation of the forward run",
                        self.manifest.catalog[key.0 as usize].name
                    ));
                }
            }
        }
        let fwd_reversed = fwd.keys().filter(|k| with_reverse.contains(&k.0)).count();
        if fwd_reversed != rev.len() {
            return Err(format!(
                "reverse coverage drift: {fwd_reversed} forward facts under reversed \
                 predicates vs {} reverse facts",
                rev.len()
            ));
        }
        Ok(())
    }
}

/// §9.1 canonical state sha over the reader's live fact set, in §9.2 canonical
/// order (perspective NAME, predicate NAME, tuple canon bytes — never interned
/// ids).
///
/// SCOPE OF THE INVARIANCE, stated exactly (round-012-pre D6 pinned this call,
/// and it is narrower than "id-independent"): the ORDERING and the fact-key
/// bytes are over names, so the digest is invariant to how predicates and
/// perspectives were interned. The per-assertion AUTHOR component is NOT — §9.1
/// normatively says `u32(author)`, and D6 pinned that u32 to the author's
/// shortlex rank in this manifest's `authors` table. Consequences, both real:
/// the digest is invariant to the ORDER in which authors were interned (the
/// table is sorted), but it is NOT injective over author NAMES — renaming an
/// author without changing its rank leaves the digest unchanged, and two stores
/// with different author sets that happen to sort to the same ranks are
/// indistinguishable. Digesting the author NAME instead would close that, at
/// the cost of diverging from the §9.1 formula and from D6; it is escalated as
/// OWNER-RULINGS OQ-C3-1 and pinned honestly by
/// `canonical_state_sha_author_component_is_the_rank_not_the_name`. The rule as
/// implemented is recorded in the manifest itself
/// (`schemes.author_interning`), so a reader never has to infer it.
pub fn canonical_state_sha(man: &RoflManifest, facts: &FactMap) -> [u8; 32] {
    let mut entries: Vec<(&str, &str, &Vec<u8>, &Vec<Value>, &BTreeSet<(u32, u64)>)> = facts
        .iter()
        .map(|((pred, persp, bytes), (tuple, asserts))| {
            (
                man.perspectives[*persp as usize].as_str(),
                man.catalog[*pred as usize].name.as_str(),
                bytes,
                tuple,
                asserts,
            )
        })
        .collect();
    entries.sort_by(|a, b| {
        a.0.as_bytes()
            .cmp(b.0.as_bytes())
            .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
            .then_with(|| a.2.cmp(b.2))
    });
    let max_tick = entries
        .iter()
        .flat_map(|(_, _, _, _, asserts)| asserts.iter().map(|&(_, t)| t))
        .max()
        .unwrap_or(0);
    let bool_tag = TagV2::bool_one();
    let mut input: Vec<u8> = Vec::new();
    input.extend_from_slice(b"ROFL-STATE-v1\n");
    push_varint(&mut input, max_tick);
    for (persp, pred, _, tuple, asserts) in &entries {
        fact_key_canon_bytes(persp, pred, tuple, &mut input)
            .expect("stored tuples are canonical");
        push_varint(&mut input, asserts.len() as u64);
        for &(author, tick) in asserts.iter() {
            input.extend_from_slice(&author.to_le_bytes());
            input.extend_from_slice(&tick.to_le_bytes());
            input.extend_from_slice(&BOOLTAG_SEMIRING_ID.to_le_bytes());
            push_varint(&mut input, bool_tag.bytes.len() as u64);
            input.extend_from_slice(&bool_tag.bytes);
        }
    }
    *blake3::hash(&input).as_bytes()
}

// ── C1: record reassembly + round-trip (§10.5 C1; round-012-pre E8) ──

/// A record normalized through the §10.1 mapping (S8): `_source`/`_generation`
/// become (author, tick); blob copies of column-authoritative keys are absent
/// (S5); metadata values are canonical JSON text keyed by original name.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct NormNode {
    /// Node id.
    pub id: u128,
    /// §10.1 author (`$legacy` when `_source` was missing).
    pub author: String,
    /// §10.1 tick (0 when `_generation` was missing).
    pub tick: u64,
    /// node_type column.
    pub node_type: String,
    /// semantic_id column ("" round-trips as an omitted sid fact).
    pub semantic_id: String,
    /// name column.
    pub name: String,
    /// file column.
    pub file: String,
    /// content_hash column. The stage-1 vocabulary carries NO predicate for it,
    /// so reassembly can only produce 0 — which is sound ONLY because
    /// `load_input` hard-aborts (E-CONV-ENVELOPE) on any nonzero content_hash.
    /// Comparing the field here makes C1 re-prove that gate on the real data
    /// instead of trusting it: weaken the gate and C1 goes red.
    pub content_hash: u64,
    /// Non-reserved metadata, sorted by key, values as canonical JSON text.
    pub meta: Vec<(String, String)>,
}

/// Edge companion of [`NormNode`].
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct NormEdge {
    /// src node id.
    pub src: u128,
    /// dst node id.
    pub dst: u128,
    /// edge_type.
    pub edge_type: String,
    /// §10.1 author.
    pub author: String,
    /// §10.1 tick.
    pub tick: u64,
    /// Non-reserved metadata, sorted by key, values as canonical JSON text.
    pub meta: Vec<(String, String)>,
}

/// Normalize an INPUT node record (the left side of the C1 comparison).
///
/// The S5 blob copies (`name`/`file`/`semantic_id` repeated inside the metadata
/// blob) are dropped on BOTH sides, which would make C1 blind to a copy that
/// disagreed with its column — so the blindness is closed elsewhere, not here:
/// the decomposition counts every disagreement in `blob_copies_differing`, and
/// `gate_silent_drops` turns a nonzero count into a hard E-CONV-ENVELOPE abort
/// before anything is written. Given that gate, dropping an AGREEING copy is
/// lossless (the column carries the value). Edges have no such columns, so
/// [`normalize_edge`] deliberately filters only the reserved keys and an edge's
/// `name`/`file` metadata round-trips as a `$meta:`-guarded fact.
pub fn normalize_node(n: &NodeIn) -> NormNode {
    let meta = n
        .meta
        .iter()
        .filter(|(k, _)| {
            !super::RESERVED_META_KEYS.contains(&k.as_str())
                && !super::COLUMN_META_KEYS.contains(&k.as_str())
        })
        .map(|(k, v)| (k.clone(), serde_json::to_string(v).expect("re-serializable")))
        .collect();
    NormNode {
        id: n.rec.id,
        author: n.author.clone(),
        tick: n.tick,
        node_type: n.rec.node_type.clone(),
        semantic_id: n.rec.semantic_id.clone(),
        name: n.rec.name.clone(),
        file: n.rec.file.clone(),
        content_hash: n.rec.content_hash,
        meta,
    }
}

/// Normalize an INPUT edge record.
pub fn normalize_edge(e: &EdgeIn) -> NormEdge {
    let meta = e
        .meta
        .iter()
        .filter(|(k, _)| !super::RESERVED_META_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), serde_json::to_string(v).expect("re-serializable")))
        .collect();
    NormEdge {
        src: e.rec.src,
        dst: e.rec.dst,
        edge_type: e.rec.edge_type.clone(),
        author: e.author.clone(),
        tick: e.tick,
        meta,
    }
}

/// A reassembled node group plus its type-fact fid (the conflict join column).
#[derive(Debug, Clone)]
pub struct ReNode {
    /// The normalized record.
    pub node: NormNode,
    /// fid of the group's `type` fact — joins to conflict/5 winner/loser fids.
    pub type_fid: u128,
}

/// Reassembly of the converted store back into records.
pub struct Reassembled {
    /// Node groups.
    pub nodes: Vec<ReNode>,
    /// Edge groups.
    pub edges: Vec<NormEdge>,
}

fn value_to_json_text(retyped: bool, v: &Value) -> Result<String, String> {
    let json: serde_json::Value = match v {
        Value::Id(x) => {
            if !retyped {
                return Err(format!("Id value {x:x} under a non-retyped predicate"));
            }
            serde_json::Value::String(x.to_string())
        }
        Value::Str(s) => serde_json::Value::String(s.clone()),
        Value::Int(i) => serde_json::Value::Number((*i).into()),
        Value::Float(f) => serde_json::Value::Number(
            serde_json::Number::from_f64(*f).ok_or("non-finite float in store")?,
        ),
        Value::BigInt(bytes) => {
            // Only u64-range positives are ever produced (S4).
            if bytes.len() > 16 || bytes.first().is_some_and(|b| b & 0x80 != 0) {
                return Err("BigInt outside the S4 envelope".to_string());
            }
            let mut x: u128 = 0;
            for &b in bytes.iter() {
                x = (x << 8) | u128::from(b);
            }
            let u: u64 = x.try_into().map_err(|_| "BigInt exceeds u64".to_string())?;
            serde_json::Value::Number(u.into())
        }
        Value::Term(t) => match (t.functor.as_str(), t.args.len()) {
            ("$true", 0) => serde_json::Value::Bool(true),
            ("$false", 0) => serde_json::Value::Bool(false),
            ("$null", 0) => serde_json::Value::Null,
            ("$json", 1) => {
                let Value::Str(text) = &t.args[0] else {
                    return Err("$json term without a Str payload".to_string());
                };
                serde_json::from_str(text).map_err(|e| format!("stored $json unparseable: {e}"))?
            }
            other => return Err(format!("unknown term shape {other:?} in metadata")),
        },
    };
    Ok(serde_json::to_string(&json).expect("re-serializable"))
}

/// Reassemble records from the fact map: one record per (subject, author,
/// tick) group — the exact inverse of the §6.2 decomposition + §10.1 mapping.
pub fn reassemble(man: &RoflManifest, facts: &FactMap) -> Result<Reassembled, String> {
    let kind_of: Vec<&str> = man.catalog.iter().map(|d| d.kind.as_str()).collect();
    let name_of: Vec<&str> = man.catalog.iter().map(|d| d.name.as_str()).collect();
    let author_name = |id: u32| -> &str { man.authors[id as usize].as_str() };

    // Pass 1: edge base facts → edge groups + the EID map (variant A).
    let mut eid_map: HashMap<u128, (u128, u128, u32)> = HashMap::new();
    let mut edge_groups: BTreeMap<(u128, u128, u32, u32, u64), BTreeMap<String, String>> =
        BTreeMap::new();
    for ((pred, _persp, _), (tuple, asserts)) in facts {
        if kind_of[*pred as usize] != "edge" {
            continue;
        }
        let (Value::Id(src), Value::Id(dst)) = (&tuple[0], &tuple[1]) else {
            return Err(format!("edge fact of '{}' without Id endpoints", name_of[*pred as usize]));
        };
        let eid = fid(PERSPECTIVE_MAIN_NAME, name_of[*pred as usize], tuple)
            .map_err(|e| e.to_string())?;
        eid_map.insert(eid, (*src, *dst, *pred));
        for &(author, tick) in asserts {
            edge_groups.insert((*src, *dst, *pred, author, tick), BTreeMap::new());
        }
    }

    // Pass 2: core node facts → node groups.
    #[derive(Default)]
    struct NodeAcc {
        node_type: Option<String>,
        semantic_id: Option<String>,
        name: Option<String>,
        file: Option<String>,
        meta: BTreeMap<String, String>,
    }
    let mut node_groups: BTreeMap<(u128, u32, u64), NodeAcc> = BTreeMap::new();
    let mut node_subjects: BTreeSet<u128> = BTreeSet::new();
    for ((pred, _persp, _), (tuple, asserts)) in facts {
        if kind_of[*pred as usize] != "core" {
            continue;
        }
        let Value::Id(subject) = tuple[0] else {
            return Err(format!("core fact of '{}' without an Id subject", name_of[*pred as usize]));
        };
        let Value::Str(value) = &tuple[1] else {
            return Err(format!("core fact of '{}' without a Str value", name_of[*pred as usize]));
        };
        node_subjects.insert(subject);
        for &(author, tick) in asserts {
            let acc = node_groups.entry((subject, author, tick)).or_default();
            let slot = match name_of[*pred as usize] {
                "type" => &mut acc.node_type,
                "sid" => &mut acc.semantic_id,
                "name" => &mut acc.name,
                "file" => &mut acc.file,
                other => return Err(format!("unknown core predicate '{other}'")),
            };
            if slot.is_some() {
                return Err(format!(
                    "two '{}' values inside one (subject, author, tick) group {subject:x}",
                    name_of[*pred as usize]
                ));
            }
            *slot = Some(value.clone());
        }
    }

    // Pass 3: meta/retyped/span facts attach to their groups by subject.
    for ((pred, _persp, _), (tuple, asserts)) in facts {
        let kind = kind_of[*pred as usize];
        if !matches!(kind, "meta" | "retyped" | "span") {
            continue;
        }
        let Value::Id(subject) = tuple[0] else {
            return Err(format!("'{}' fact without an Id subject", name_of[*pred as usize]));
        };
        let is_edge_subject = eid_map.contains_key(&subject);
        if is_edge_subject && node_subjects.contains(&subject) {
            return Err(format!(
                "subject {subject:x} is both a node id and a computed EID — ambiguous reassembly"
            ));
        }
        // Expand into (key, json-text) pairs.
        let mut kvs: Vec<(String, String)> = Vec::new();
        if kind == "span" {
            for (i, key) in SPAN_KEYS.iter().enumerate() {
                let Value::Int(x) = tuple[i + 1] else {
                    return Err("span fact with a non-Int column".to_string());
                };
                kvs.push((
                    key.to_string(),
                    serde_json::to_string(&serde_json::Value::Number(x.into()))
                        .expect("re-serializable"),
                ));
            }
        } else {
            let name = name_of[*pred as usize];
            let key = name.strip_prefix(META_PREFIX).unwrap_or(name).to_string();
            kvs.push((key, value_to_json_text(kind == "retyped", &tuple[1])?));
        }
        for &(author, tick) in asserts {
            let target: &mut BTreeMap<String, String> = if is_edge_subject {
                let (src, dst, epred) = eid_map[&subject];
                edge_groups
                    .get_mut(&(src, dst, epred, author, tick))
                    .ok_or_else(|| {
                        format!(
                            "orphan edge-meta assertion on {subject:x} (author {author}, \
                             tick {tick})"
                        )
                    })?
            } else {
                &mut node_groups
                    .get_mut(&(subject, author, tick))
                    .ok_or_else(|| {
                        format!(
                            "orphan node-meta assertion on {subject:x} (author {author}, \
                             tick {tick})"
                        )
                    })?
                    .meta
            };
            for (k, v) in &kvs {
                if target.insert(k.clone(), v.clone()).is_some() {
                    return Err(format!("duplicate metadata key '{k}' on {subject:x}"));
                }
            }
        }
    }

    let mut nodes = Vec::with_capacity(node_groups.len());
    for ((subject, author, tick), acc) in node_groups {
        let node_type = acc
            .node_type
            .ok_or_else(|| format!("group {subject:x} has no type fact"))?;
        let type_fid = fid(
            PERSPECTIVE_MAIN_NAME,
            "type",
            &[Value::Id(subject), Value::Str(node_type.clone())],
        )
        .map_err(|e| e.to_string())?;
        nodes.push(ReNode {
            node: NormNode {
                id: subject,
                author: author_name(author).to_string(),
                tick,
                node_type,
                semantic_id: acc.semantic_id.unwrap_or_default(),
                name: acc.name.unwrap_or_default(),
                file: acc.file.unwrap_or_default(),
                // No stage-1 predicate carries content_hash; the input gate
                // proves every input record's is 0 (see [`NormNode`]).
                content_hash: 0,
                meta: acc.meta.into_iter().collect(),
            },
            type_fid,
        });
    }
    let mut edges = Vec::with_capacity(edge_groups.len());
    for ((src, dst, epred, author, tick), meta) in edge_groups {
        edges.push(NormEdge {
            src,
            dst,
            edge_type: name_of[epred as usize].to_string(),
            author: author_name(author).to_string(),
            tick,
            meta: meta.into_iter().collect(),
        });
    }
    Ok(Reassembled { nodes, edges })
}

// ── C1 verification ────────────────────────────────────────────────

/// One C1 exception: a record excluded from the RESOLVED view, mechanically
/// joined to its conflict/5 fact (the §10.5 C1 requirement verbatim).
#[derive(Debug, Clone, Serialize)]
pub struct C1Exception {
    /// Subject id (hex).
    pub subject: String,
    /// The loser record's semantic_id.
    pub semantic_id: String,
    /// The loser record's node_type.
    pub loser_type: String,
    /// The winning node_type per conflict/5.
    pub winner_type: String,
    /// The loser record's author.
    pub loser_author: String,
    /// The loser record's tick.
    pub loser_tick: u64,
    /// The joining conflict/5 predicate column.
    pub conflict_pred: String,
    /// The joining conflict/5 loser fid (hex).
    pub loser_fid: String,
}

/// The C1 verification summary (part of the report).
#[derive(Debug, Clone, Serialize)]
pub struct C1Summary {
    /// Input node records (post-S2).
    pub input_nodes: u64,
    /// Input edge records.
    pub input_edges: u64,
    /// Reassembled node groups.
    pub reassembled_nodes: u64,
    /// Reassembled edge groups.
    pub reassembled_edges: u64,
    /// FULL round-trip: reassembled multiset == normalized input multiset.
    pub full_multiset_equal: bool,
    /// Node records differing (symmetric difference size).
    pub node_mismatches: u64,
    /// Edge records differing.
    pub edge_mismatches: u64,
    /// The resolved-view exceptions, each joined to conflict/5.
    pub exceptions: Vec<C1Exception>,
    /// Distinct INPUT subjects carrying more than one node record. Reported so
    /// the conflict machinery cannot be judged against its own output.
    pub input_multi_record_subjects: u64,
    /// Of those, the subjects whose records disagree on `node_type` — the exact
    /// population that MUST produce a `type` conflict/5.
    pub input_type_divergent_subjects: u64,
    /// Distinct subjects covered by a `type` conflict/5 in the store.
    pub type_conflict_subjects: u64,
    /// Every conflict loser maps into the exception set, the exception count
    /// equals the type-conflict count, AND every input-derived type-divergent
    /// subject is covered by a conflict (so a store that emitted ZERO conflicts
    /// cannot pass vacuously).
    pub resolved_view_consistent: bool,
}

fn multiset_diff<T: Ord + Clone>(a: &[T], b: &[T]) -> u64 {
    let mut counts: BTreeMap<&T, i64> = BTreeMap::new();
    for x in a {
        *counts.entry(x).or_default() += 1;
    }
    for x in b {
        *counts.entry(x).or_default() -= 1;
    }
    counts.values().map(|c| c.unsigned_abs()).sum()
}

/// C1 (§10.5): old base → facts → reassembled records; multiset comparison
/// with the 39 Functional-resolution exceptions enumerated and joined to
/// their conflict/5 facts. Fully disk-driven on both sides.
pub fn verify_c1(input: &Path, store_root: &Path) -> Result<C1Summary, ConvertError> {
    let (in_nodes, in_edges, _counters) = super::load_input(input)?;
    let store = ConvertedStore::open(store_root).map_err(|e| cerr("E-CONV-VERIFY", e))?;
    let facts = store.load_facts().map_err(|e| cerr("E-CONV-VERIFY", e))?;
    let re = reassemble(&store.manifest, &facts).map_err(|e| cerr("E-CONV-VERIFY", e))?;

    let input_nodes: Vec<NormNode> = in_nodes.iter().map(normalize_node).collect();
    let input_edges: Vec<NormEdge> = in_edges.iter().map(normalize_edge).collect();
    let re_nodes: Vec<NormNode> = re.nodes.iter().map(|r| r.node.clone()).collect();

    let node_mismatches = multiset_diff(&input_nodes, &re_nodes);
    let edge_mismatches = multiset_diff(&input_edges, &re.edges);

    // Conflict/5 join: collect type-conflict losers (and all losers per pred).
    let man = &store.manifest;
    let conflict_pred = man.catalog.iter().find(|d| d.name == "conflict");
    let mut type_losers: HashMap<u128, (u128, u128)> = HashMap::new(); // loser_fid → (subject, winner_fid)
    let mut other_losers: Vec<(String, u128, u128)> = Vec::new(); // (pred, subject, loser_fid)
    if let Some(cdecl) = conflict_pred {
        for ((pred, _persp, _), (tuple, _)) in &facts {
            if *pred != cdecl.id {
                continue;
            }
            let (Value::Id(subject), Value::Str(pname), Value::Id(winner), Value::Id(loser)) =
                (&tuple[0], &tuple[1], &tuple[2], &tuple[3])
            else {
                return Err(cerr("E-CONV-VERIFY", "malformed conflict/5 tuple"));
            };
            if pname == "type" {
                type_losers.insert(*loser, (*subject, *winner));
            } else {
                other_losers.push((pname.clone(), *subject, *loser));
            }
        }
    }
    // Winner-type lookup by fid over the conflicted subjects' type facts.
    let type_decl = man.catalog.iter().find(|d| d.name == "type");
    let mut type_value_by_fid: HashMap<u128, String> = HashMap::new();
    if let Some(tdecl) = type_decl {
        let subjects: BTreeSet<u128> = type_losers.values().map(|&(s, _)| s).collect();
        for ((pred, _persp, _), (tuple, _)) in &facts {
            if *pred != tdecl.id {
                continue;
            }
            let Value::Id(subject) = tuple[0] else { continue };
            if !subjects.contains(&subject) {
                continue;
            }
            let f = fid(PERSPECTIVE_MAIN_NAME, "type", tuple)
                .map_err(|e| cerr("E-CONV-VERIFY", e))?;
            if let Value::Str(v) = &tuple[1] {
                type_value_by_fid.insert(f, v.clone());
            }
        }
    }

    let mut exceptions: Vec<C1Exception> = Vec::new();
    let mut exception_keys: BTreeSet<(u128, String, u64)> = BTreeSet::new();
    for r in &re.nodes {
        if let Some(&(subject, winner_fid)) =
            type_losers.get(&r.type_fid).filter(|&&(s, _)| s == r.node.id)
        {
            exception_keys.insert((r.node.id, r.node.author.clone(), r.node.tick));
            // A conflict/5 names a winner fid; the winner fact MUST be present
            // in the store the conflict was written into. An absent one is a
            // dangling audit reference, not an empty string.
            let winner_type = type_value_by_fid.get(&winner_fid).cloned().ok_or_else(|| {
                cerr(
                    "E-CONV-VERIFY",
                    format!(
                        "conflict/5 on {subject:032x} names winner fid {winner_fid:032x}, \
                         which no live `type` fact of that subject carries"
                    ),
                )
            })?;
            exceptions.push(C1Exception {
                subject: format!("{subject:032x}"),
                semantic_id: r.node.semantic_id.clone(),
                loser_type: r.node.node_type.clone(),
                winner_type,
                loser_author: r.node.author.clone(),
                loser_tick: r.node.tick,
                conflict_pred: "type".to_string(),
                loser_fid: format!("{:032x}", r.type_fid),
            });
        }
    }
    // Total order: `subject` alone is NOT a key (one subject can lose more than
    // once), so sorting on it leaves the report's row order at the mercy of the
    // sort's stability and of upstream iteration order.
    exceptions.sort_by(|a, b| {
        a.subject
            .cmp(&b.subject)
            .then_with(|| a.loser_fid.cmp(&b.loser_fid))
            .then_with(|| a.loser_author.cmp(&b.loser_author))
            .then_with(|| a.loser_tick.cmp(&b.loser_tick))
    });

    // NON-VACUITY (the C1 counterpart of the run-level coverage gate): derive
    // the conflict population from the INPUT, independently of anything the
    // converter emitted. Every subject whose input records disagree on
    // node_type must be covered by a `type` conflict/5. Without this, a
    // converter that emitted ZERO conflicts would satisfy every other clause
    // below by construction (0 == 0) and C1 would call it consistent.
    let mut records_by_subject: HashMap<u128, Vec<&NormNode>> = HashMap::new();
    for n in &input_nodes {
        records_by_subject.entry(n.id).or_default().push(n);
    }
    let mut input_multi_record_subjects: u64 = 0;
    let mut type_divergent: BTreeSet<u128> = BTreeSet::new();
    for (subject, recs) in &records_by_subject {
        if recs.len() < 2 {
            continue;
        }
        input_multi_record_subjects += 1;
        let first = recs[0].node_type.as_str();
        if recs.iter().any(|r| r.node_type != first) {
            type_divergent.insert(*subject);
        }
    }
    let conflict_subjects: BTreeSet<u128> = type_losers.values().map(|&(s, _)| s).collect();
    let mut consistent = type_divergent.is_subset(&conflict_subjects);

    // Consistency: every type loser found exactly one exception group, and
    // every OTHER predicate's loser fact lives inside the exception groups.
    consistent &= exceptions.len() == type_losers.len();
    for (pname, subject, loser_fid) in &other_losers {
        let decl = man.catalog.iter().find(|d| &d.name == pname);
        let Some(decl) = decl else {
            consistent = false;
            continue;
        };
        let mut found = false;
        for ((pred, _persp, _), (tuple, asserts)) in &facts {
            if *pred != decl.id {
                continue;
            }
            if !matches!(tuple[0], Value::Id(s) if s == *subject) {
                continue;
            }
            let f = fid(PERSPECTIVE_MAIN_NAME, pname, tuple)
                .map_err(|e| cerr("E-CONV-VERIFY", e))?;
            if f != *loser_fid {
                continue;
            }
            found = true;
            for &(author, tick) in asserts {
                let author_name = store.manifest.authors[author as usize].clone();
                if !exception_keys.contains(&(*subject, author_name, tick)) {
                    consistent = false;
                }
            }
        }
        if !found {
            consistent = false;
        }
    }

    Ok(C1Summary {
        input_nodes: input_nodes.len() as u64,
        input_edges: input_edges.len() as u64,
        reassembled_nodes: re_nodes.len() as u64,
        reassembled_edges: re.edges.len() as u64,
        full_multiset_equal: node_mismatches == 0 && edge_mismatches == 0,
        node_mismatches,
        edge_mismatches,
        exceptions,
        input_multi_record_subjects,
        input_type_divergent_subjects: type_divergent.len() as u64,
        type_conflict_subjects: conflict_subjects.len() as u64,
        resolved_view_consistent: consistent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::convert::manifest::{DeclJson, ProvenanceJson, SegmentJson, FORMAT_TAG};
    use crate::facts::convert::segment::{encode_segment, read_segment, PhysRow};
    use crate::facts::convert::{run, RunOptions};
    use crate::facts::lsm::{LsmFactStore, SEEDED_PRIORITY_HIGH, SEEDED_PRIORITY_LOW};
    use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2};

    // ── the end-to-end fixture ─────────────────────────────────────

    fn node(id: u128, ty: &str, name: &str, file: &str, sid: &str, meta: serde_json::Value) -> NodeRecordV2 {
        NodeRecordV2 {
            semantic_id: sid.to_string(),
            id,
            node_type: ty.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: if meta.is_null() {
                String::new()
            } else {
                meta.to_string()
            },
        }
    }

    fn edge(src: u128, dst: u128, ty: &str, meta: serde_json::Value) -> EdgeRecordV2 {
        EdgeRecordV2 {
            src,
            dst,
            edge_type: ty.to_string(),
            metadata: if meta.is_null() {
                String::new()
            } else {
                meta.to_string()
            },
        }
    }

    /// A small base exercising every stage-1 decomposition path: a full span,
    /// every S4 value shape, both S6 collision classes, a D4 retype, S5 blob
    /// copies, an empty `name` column, a `$legacy`/tick-0 record, a
    /// string-typed `_generation`, a TICK-TIE conflict pair, and edges with
    /// and without metadata.
    fn fixture_input(dir: &std::path::Path) {
        let n1 = node(
            11,
            "FUNCTION",
            "fn1",
            "a/f.js",
            "a/f.js->FUNCTION->fn1",
            serde_json::json!({
                "_source": "analyzer",
                "_generation": 3,
                "line": 5, "column": 0, "endLine": 9, "endColumn": 40,
                "async": true,
                "deprecated": false,
                "doc": null,
                "arity": 2,
                "weight": 1.5,
                "huge": 18446744073709551615u64,
                "nested": {"a": 1, "b": [2, 3]},
                "list": [1, "x", null],
                "source_node": "340282366920938463463374607431768211455",
                "type": "shadowed-core-name",
                "CALLS": "shadowed-edge-type-name",
                "name": "fn1",
                "file": "a/f.js",
                "semantic_id": "a/f.js->FUNCTION->fn1"
            }),
        );
        // No metadata at all → `$legacy` author, tick 0 (the ABSENT-generation
        // round-trip).
        let n2 = node(22, "CLASS", "cls", "b/g.js", "b/g.js->CLASS->cls", serde_json::Value::Null);
        // String-typed `_generation`, and an EMPTY name column.
        let n5 = node(
            55,
            "VARIABLE",
            "",
            "b/g.js",
            "b/g.js->VARIABLE->",
            serde_json::json!({"_source": "enricher", "_generation": "9", "partial": 1}),
        );
        // The conflict pair: same id, same name/file/sid, DIFFERENT type, tick tie.
        let n3 = node(
            30,
            "GLOBAL_DEFINITION",
            "g",
            "c/h.hs",
            "c/h.hs->g",
            serde_json::json!({"_source": SEEDED_PRIORITY_HIGH, "_generation": 1}),
        );
        let n4 = node(
            30,
            "EXTERNAL_FUNCTION",
            "g",
            "c/h.hs",
            "c/h.hs->g",
            serde_json::json!({"_source": SEEDED_PRIORITY_LOW, "_generation": 1}),
        );

        let e1 = edge(
            11,
            22,
            "CALLS",
            serde_json::json!({
                "_source": "analyzer", "_generation": 3,
                "line": 5, "column": 1, "endLine": 5, "endColumn": 9,
                "name": "blob-copy-on-an-edge",
                "handler_function_id": "22"
            }),
        );
        let e2 = edge(11, 55, "CONTAINS", serde_json::Value::Null);
        let e3 = edge(
            22,
            55,
            "CALLS",
            serde_json::json!({"_source": "enricher", "dynamic": true}),
        );

        {
            let fs = LsmFactStore::create(dir, 2).expect("create input store");
            fs.commit_legacy(vec![n1, n2, n5], vec![e1, e2, e3], &[]);
            // The conflict pair goes in as separate versions of node 30.
            fs.commit_legacy(vec![n3], vec![], &[]);
            fs.commit_legacy(vec![n4], vec![], &[]);
        }
        let _ = std::fs::remove_file(dir.join("LOCK"));
    }

    fn copy_tree(src: &std::path::Path, dst: &std::path::Path) {
        std::fs::create_dir_all(dst).expect("mkdir");
        for entry in std::fs::read_dir(src).expect("read_dir") {
            let entry = entry.expect("entry");
            let from = entry.path();
            let to = dst.join(entry.file_name());
            if from.is_dir() {
                copy_tree(&from, &to);
            } else {
                std::fs::copy(&from, &to).expect("copy file");
            }
        }
    }

    /// End-to-end: synthetic records → converted store → reassembly → C1 CLEAN.
    #[test]
    fn end_to_end_fixture_round_trips_and_c1_is_clean() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let input = tmp.path().join("in");
        std::fs::create_dir(&input).expect("mkdir in");
        fixture_input(&input);
        let output = tmp.path().join("out");

        let report = run(&RunOptions {
            input: input.clone(),
            output: output.clone(),
            verify_c1: true,
        })
        .expect("conversion succeeds");

        // Every decomposition path really fired (otherwise C1 would be
        // vacuously clean over a trivial base).
        assert_eq!(report.decompose.span_facts, 2, "n1 and e1 spans collapsed");
        assert_eq!(report.decompose.partial_span_subjects, 0);
        assert_eq!(report.decompose.json_composite_values, 2, "object + array");
        assert_eq!(report.decompose.null_values, 1);
        assert_eq!(report.decompose.meta_prefixed_keys, 3, "type, CALLS, edge-side name");
        assert_eq!(report.decompose.blob_copies_skipped, 3, "n1's name/file/semantic_id");
        assert_eq!(report.decompose.blob_copies_differing, 0);
        assert_eq!(report.decompose.empty_name, 1, "n5");
        assert_eq!(report.decompose.retyped.get("source_node"), Some(&1));
        assert_eq!(report.decompose.retyped.get("handler_function_id"), Some(&1));
        assert_eq!(report.decompose.retype_misses, 0);
        assert_eq!(report.legacy.legacy_author_nodes, 1, "n2");
        assert_eq!(report.legacy.tick0_nodes, 1, "n2");
        assert_eq!(report.legacy.legacy_author_edges, 1, "e2");
        assert_eq!(report.conflicts.total, 1, "exactly the type tie on node 30");

        // C1 is clean.
        let c1 = report.c1.as_ref().expect("verify_c1 requested");
        assert!(c1.full_multiset_equal, "C1 round-trip must be exact: {c1:?}");
        assert_eq!(c1.node_mismatches, 0);
        assert_eq!(c1.edge_mismatches, 0);
        assert_eq!(c1.input_nodes, 5);
        assert_eq!(c1.input_edges, 3);
        assert_eq!(c1.reassembled_nodes, 5);
        assert_eq!(c1.reassembled_edges, 3);
        assert_eq!(c1.exceptions.len(), 1, "the one conflict loser");
        assert!(c1.resolved_view_consistent);
        let ex = &c1.exceptions[0];
        assert_eq!(ex.conflict_pred, "type");
        assert_eq!(ex.winner_type, "GLOBAL_DEFINITION");
        assert_eq!(ex.loser_type, "EXTERNAL_FUNCTION");
        assert_eq!(ex.loser_author, SEEDED_PRIORITY_LOW);
        assert_eq!(ex.loser_tick, 1);

        // The reader's own path, explicitly: open from disk → facts → reassemble.
        let store = ConvertedStore::open(&output).expect("open converted store");
        assert_eq!(store.manifest.format, FORMAT_TAG);
        // Shortlex, so "main" (4) precedes "audit" (5) and main IS id 0.
        assert_eq!(store.manifest.perspectives, vec!["main", "audit"]);
        let facts = store.load_facts().expect("load facts");
        store
            .verify_reverse_runs(&facts)
            .expect("reverse runs are permutations of the forward runs");
        let recomputed: String = canonical_state_sha(&store.manifest, &facts)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            recomputed, store.manifest.canonical_state_sha,
            "the persisted sha is what the reader recomputes"
        );
        let re = reassemble(&store.manifest, &facts).expect("reassembles");
        assert_eq!(re.nodes.len(), 5);
        assert_eq!(re.edges.len(), 3);

        // tick 0 round-trips as an ABSENT `_generation` (n2 carried no metadata
        // at all, so its reassembled record must have $legacy/0 and NO meta).
        let n2 = re.nodes.iter().find(|r| r.node.id == 22).expect("n2 reassembled");
        assert_eq!(n2.node.author, "$legacy");
        assert_eq!(n2.node.tick, 0);
        assert!(n2.node.meta.is_empty(), "no `_generation` key reappears");

        // n1: the span expanded back into FOUR keys, the S6 guards stripped, the
        // retype rendered as its decimal string, every S4 shape restored.
        let n1 = re.nodes.iter().find(|r| r.node.id == 11).expect("n1 reassembled");
        let meta: BTreeMap<&str, &str> = n1
            .node
            .meta
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        for key in SPAN_KEYS {
            assert!(meta.contains_key(key), "span key {key} must come back");
        }
        assert_eq!(meta["line"], "5");
        assert_eq!(meta["column"], "0", "`column: 0` is a value, not an absence");
        assert_eq!(meta["endColumn"], "40");
        assert_eq!(meta["async"], "true");
        assert_eq!(meta["deprecated"], "false");
        assert_eq!(meta["doc"], "null");
        assert_eq!(meta["weight"], "1.5");
        assert_eq!(meta["huge"], "18446744073709551615");
        assert_eq!(meta["nested"], "{\"a\":1,\"b\":[2,3]}");
        assert_eq!(meta["list"], "[1,\"x\",null]");
        assert_eq!(
            meta["source_node"], "\"340282366920938463463374607431768211455\"",
            "the retyped Id renders back as its canonical decimal string"
        );
        assert_eq!(meta["type"], "\"shadowed-core-name\"", "$meta: guard stripped");
        assert_eq!(meta["CALLS"], "\"shadowed-edge-type-name\"");
        assert!(!meta.contains_key("name"), "S5 blob copy stays absent");
        assert!(!meta.contains_key("semantic_id"));
        assert!(!meta.contains_key("_source"));

        // The edge-side `$meta:name` guard also strips back.
        let e1 = re
            .edges
            .iter()
            .find(|e| (e.src, e.dst, e.edge_type.as_str()) == (11, 22, "CALLS"))
            .expect("e1 reassembled");
        let emeta: BTreeMap<&str, &str> = e1
            .meta
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(emeta["name"], "\"blob-copy-on-an-edge\"");
        assert_eq!(emeta["handler_function_id"], "\"22\"");
        assert_eq!(emeta["line"], "5");
    }

    /// The one that matters most: `verify_c1` must NOT be vacuous. Perturb a
    /// single `name` value inside a written segment — keeping the descriptor's
    /// predicate, direction and ROW COUNT intact, so `load_run`'s structural
    /// checks all still pass — and C1 must report the difference.
    #[test]
    fn perturbed_store_makes_c1_report_a_difference() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let input = tmp.path().join("in");
        std::fs::create_dir(&input).expect("mkdir in");
        fixture_input(&input);
        let output = tmp.path().join("out");
        run(&RunOptions {
            input: input.clone(),
            output: output.clone(),
            verify_c1: true,
        })
        .expect("baseline conversion succeeds");
        let _ = std::fs::remove_file(input.join("LOCK"));

        // Control: the untouched copy still verifies clean.
        let clean = tmp.path().join("clean");
        copy_tree(&output, &clean);
        let baseline = verify_c1(&input, &clean).expect("C1 runs");
        assert!(baseline.full_multiset_equal, "control must be clean");
        assert_eq!(baseline.node_mismatches, 0);
        let _ = std::fs::remove_file(input.join("LOCK"));

        // Perturb.
        let tampered = tmp.path().join("tampered");
        copy_tree(&output, &tampered);
        let man = RoflManifest::read(&tampered).expect("manifest");
        let name_id = man
            .catalog
            .iter()
            .find(|d| d.name == "name")
            .expect("name predicate")
            .id;
        // Tamper a row whose tuple is unique in its run, so exactly one logical
        // fact changes value and the fact COUNT stays put (node 30's `name` fact
        // carries two assertions and would split instead).
        let (desc, seg, victim) = man
            .segments
            .iter()
            .filter(|s| s.predicate == name_id && s.direction == "fwd" && s.rows > 0)
            .find_map(|s| {
                let seg = read_segment(&tampered.join(&s.path)).expect("decode");
                let victim = seg
                    .rows
                    .iter()
                    .position(|r| seg.rows.iter().filter(|o| o.tuple == r.tuple).count() == 1)?;
                Some((s.clone(), seg, victim))
            })
            .expect("some forward `name` segment holds a single-assertion row");
        let path = tampered.join(&desc.path);
        assert_eq!(seg.rows.len() as u64, desc.rows);
        let mut rows: Vec<PhysRow> = seg.rows.clone();
        let Value::Str(original) = rows[victim].tuple[1].clone() else {
            panic!("a `name` value must be a Str")
        };
        rows[victim].tuple[1] = Value::Str(format!("{original}-TAMPERED"));
        let (bytes, meta) =
            encode_segment(seg.pred_id, seg.direction, seg.arity, &rows, 0).expect("re-encode");
        std::fs::write(&path, &bytes).expect("overwrite the segment");
        // RE-SEAL the descriptor: this test is about C1's power over a store
        // that is INTERNALLY CONSISTENT (the integrity layer added for finding
        // F17/F31 would otherwise reject the file first, and C1 would never be
        // exercised at all). A converter bug produces exactly this shape — a
        // wrong value with a matching digest.
        let mut resealed = man.clone();
        for s in resealed.segments.iter_mut() {
            if s.path == desc.path {
                s.sha256 = meta.sha256.clone();
                s.bytes = bytes.len() as u64;
            }
        }
        resealed
            .write_atomic(&tampered)
            .expect("rewrite the manifest");

        // The structural checks still pass — the store OPENS and LOADS, with the
        // same fact count. Only a VALUE moved.
        let store = ConvertedStore::open(&tampered).expect("tampered store still opens");
        let facts = store.load_facts().expect("row count and ids still line up");
        assert_eq!(
            facts.len(),
            ConvertedStore::open(&clean)
                .expect("clean")
                .load_facts()
                .expect("clean facts")
                .len(),
            "same fact COUNT — only one value changed"
        );

        // ...and C1 catches it anyway.
        let summary = verify_c1(&input, &tampered).expect("C1 runs on the tampered store");
        assert!(
            !summary.full_multiset_equal,
            "verify_c1 is vacuous: it accepted a tampered store"
        );
        assert_eq!(
            summary.node_mismatches, 2,
            "one record missing on each side of the symmetric difference"
        );
        assert_eq!(summary.edge_mismatches, 0, "only the node column was touched");
        assert_eq!(summary.reassembled_nodes, summary.input_nodes);
        let _ = std::fs::remove_file(input.join("LOCK"));
    }

    // ── §9.1/§9.2: canonical_state_sha ─────────────────────────────

    fn decl(id: u32, name: &str) -> DeclJson {
        DeclJson {
            id,
            name: name.to_string(),
            kind: "meta".to_string(),
            arity: 2,
            columns: vec!["subject".to_string(), name.to_string()],
            subject_universe: "node".to_string(),
            strategy: "Attribute".to_string(),
            cardinality: "MultiValued".to_string(),
            temporal: "Timeless".to_string(),
            semiring: BOOLTAG_SEMIRING_ID,
            key_cols: vec![0],
            reverse: None,
            author_priority: vec![],
            live_facts: 0,
            live_asserts: 0,
            stats_distinct: vec![],
            stats_max_fanout: 0,
            stats_updated_at_tx: 0,
        }
    }

    fn mini_manifest(perspectives: &[&str], pred_names: &[&str]) -> RoflManifest {
        RoflManifest {
            format: FORMAT_TAG.to_string(),
            shard_count: 2,
            perspectives: perspectives.iter().map(|s| s.to_string()).collect(),
            authors: vec!["$legacy".to_string(), "analyzer".to_string()],
            schemes: crate::facts::convert::manifest::SchemesJson::v1(),
            catalog: pred_names
                .iter()
                .enumerate()
                .map(|(i, n)| decl(i as u32, n))
                .collect(),
            segments: Vec::<SegmentJson>::new(),
            provenance: ProvenanceJson {
                input_path: "in".to_string(),
                input_recursive_sha256: "0".repeat(64),
                input_size_bytes: 0,
                input_manifest_version: 1,
                converter: "test".to_string(),
            },
            perspective_ruling: "main".to_string(),
            canonical_state_sha: String::new(),
        }
    }

    /// §9.2: the canonical order is over NAMES, so the sha is invariant under
    /// (a) insertion order and (b) the whole predicate/perspective ID
    /// ASSIGNMENT — two stores holding the same logical content agree even if
    /// they interned their vocabularies differently.
    #[test]
    fn canonical_state_sha_is_order_and_id_assignment_independent() {
        let tuples: Vec<(&str, &str, Vec<Value>, Vec<(u32, u64)>)> = vec![
            ("main", "name", vec![Value::Id(1), Value::Str("a".into())], vec![(1, 7)]),
            ("main", "type", vec![Value::Id(1), Value::Str("FUNCTION".into())], vec![(0, 0), (1, 7)]),
            ("main", "file", vec![Value::Id(2), Value::Str("x.js".into())], vec![(1, 3)]),
            ("audit", "conflict", vec![Value::Id(2), Value::Str("type".into())], vec![(1, 9)]),
            ("main", "async", vec![Value::Id(2), Value::Int(1)], vec![(0, 0)]),
        ];

        let build = |persps: &[&str], preds: &[&str], reverse: bool| -> (RoflManifest, FactMap) {
            let man = mini_manifest(persps, preds);
            let mut facts: FactMap = BTreeMap::new();
            let mut src = tuples.clone();
            if reverse {
                src.reverse();
            }
            for (persp, pred, tuple, asserts) in src {
                let pid = preds.iter().position(|p| *p == pred).expect("declared") as u32;
                let sid = persps.iter().position(|p| *p == persp).expect("declared") as u32;
                facts.insert(
                    (pid, sid, tuple_canon(&tuple)),
                    (tuple, asserts.into_iter().collect()),
                );
            }
            (man, facts)
        };

        // Assignment A: canonical shortlex-ish assignment.
        let persps_a = ["audit", "main"];
        let preds_a = ["async", "conflict", "file", "name", "type"];
        let (man_a, facts_a) = build(&persps_a, &preds_a, false);
        // Assignment B: the SAME content with permuted perspective and
        // predicate ids, inserted in the opposite order.
        let persps_b = ["main", "audit"];
        let preds_b = ["type", "name", "file", "conflict", "async"];
        let (man_b, facts_b) = build(&persps_b, &preds_b, true);

        // Non-vacuity: the two maps really do iterate in different key orders.
        let order_a: Vec<(u32, u32)> = facts_a.keys().map(|(p, s, _)| (*p, *s)).collect();
        let order_b: Vec<(u32, u32)> = facts_b.keys().map(|(p, s, _)| (*p, *s)).collect();
        assert_ne!(order_a, order_b, "the id assignments must actually differ");

        let sha_a = canonical_state_sha(&man_a, &facts_a);
        let sha_b = canonical_state_sha(&man_b, &facts_b);
        assert_eq!(
            sha_a, sha_b,
            "§9.2 canonical order is over NAMES — the sha must not depend on interning"
        );

        // Negative control 1: one tick bumped → a different state, different sha.
        let (man_c, mut facts_c) = build(&persps_a, &preds_a, false);
        let key = facts_c.keys().next().expect("non-empty").clone();
        let (_, asserts) = facts_c.get_mut(&key).expect("present");
        let old = *asserts.iter().next().expect("one assertion");
        asserts.remove(&old);
        asserts.insert((old.0, old.1 + 1));
        assert_ne!(canonical_state_sha(&man_c, &facts_c), sha_a, "tick is digested");

        // Negative control 2: one assertion DROPPED → different sha.
        let (man_d, mut facts_d) = build(&persps_a, &preds_a, false);
        let key = facts_d
            .iter()
            .find(|(_, (_, a))| a.len() > 1)
            .map(|(k, _)| k.clone())
            .expect("the type fact has two assertions");
        let (_, asserts) = facts_d.get_mut(&key).expect("present");
        let first = *asserts.iter().next().expect("non-empty");
        asserts.remove(&first);
        assert_ne!(
            canonical_state_sha(&man_d, &facts_d),
            sha_a,
            "assertion count is digested"
        );

        // Negative control 3: the SAME fact map under a manifest that RENAMES
        // one predicate → different sha (the digest commits to NAMES, so a
        // vocabulary rename is a different state, not the same one).
        let mut man_e = man_a.clone();
        let pos = man_e
            .catalog
            .iter()
            .position(|d| d.name == "type")
            .expect("declared");
        man_e.catalog[pos].name = "kind".to_string();
        assert_ne!(
            canonical_state_sha(&man_e, &facts_a),
            sha_a,
            "predicate NAMES are what the digest commits to"
        );
    }

    /// The honest counterpart of the test above, and the reason OQ-C3-1 exists:
    /// the per-assertion AUTHOR component is the shortlex RANK (§9.1 `u32(author)`,
    /// pinned by round-012-pre D6), so unlike predicates and perspectives the
    /// digest does NOT commit to author names. This test PINS the limitation
    /// rather than leaving it to be discovered: renaming an author without
    /// disturbing its rank leaves the digest byte-identical, and the manifest is
    /// required to SAY so in `schemes.author_interning` so no reader has to
    /// infer it from the converter's source.
    #[test]
    fn canonical_state_sha_author_component_is_the_rank_not_the_name() {
        let man = mini_manifest(&["main"], &["type"]);
        let mut facts: FactMap = BTreeMap::new();
        let tuple = vec![Value::Id(1), Value::Str("FUNCTION".into())];
        facts.insert(
            (0, 0, tuple_canon(&tuple)),
            (tuple, [(1u32, 7u64)].into_iter().collect()),
        );
        let base = canonical_state_sha(&man, &facts);

        // Rename author id 1 ("analyzer" → "zzz-renamed"): still rank 1 in a
        // two-entry table sorted shortlex against "$legacy".
        let mut renamed = man.clone();
        renamed.authors[1] = "zzz-renamed".to_string();
        assert_eq!(
            crate::facts::convert::segment::canon_str_cmp(&renamed.authors[0], &renamed.authors[1]),
            std::cmp::Ordering::Less,
            "the rename must preserve the shortlex ORDER, else the ranks move \
             and the test would prove nothing"
        );
        assert_eq!(
            canonical_state_sha(&renamed, &facts),
            base,
            "KNOWN, RECORDED limitation (OQ-C3-1): the digest commits to author \
             RANKS, so a rank-preserving rename is invisible to it"
        );

        // What DOES move the digest: the rank itself.
        let mut reranked = man.clone();
        let mut facts_reranked: FactMap = BTreeMap::new();
        let tuple2 = vec![Value::Id(1), Value::Str("FUNCTION".into())];
        facts_reranked.insert(
            (0, 0, tuple_canon(&tuple2)),
            (tuple2, [(0u32, 7u64)].into_iter().collect()),
        );
        reranked.authors = vec!["analyzer".to_string(), "$legacy".to_string()];
        assert_ne!(
            canonical_state_sha(&reranked, &facts_reranked),
            base,
            "the rank IS digested"
        );

        // And the store is required to publish the rule it used.
        assert!(
            man.schemes.author_interning.contains("shortlex-rank")
                && man.schemes.author_interning.contains("OQ-C3-1"),
            "the manifest must state the author-interning rule and its open question"
        );
    }

    /// Integrity: the manifest's per-segment `sha256` must be a COMMITMENT. A
    /// byte-level edit that leaves every structural invariant intact (same
    /// predicate, direction, row count, arity) has to be rejected at load, not
    /// silently decoded.
    #[test]
    fn a_segment_whose_bytes_disagree_with_the_manifest_digest_is_rejected() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let input = tmp.path().join("in");
        std::fs::create_dir(&input).expect("mkdir in");
        fixture_input(&input);
        let output = tmp.path().join("out");
        run(&RunOptions {
            input: input.clone(),
            output: output.clone(),
            verify_c1: false,
        })
        .expect("conversion succeeds");
        let _ = std::fs::remove_file(input.join("LOCK"));

        let man = RoflManifest::read(&output).expect("manifest");
        let name_id = man
            .catalog
            .iter()
            .find(|d| d.name == "name")
            .expect("name predicate")
            .id;
        let desc = man
            .segments
            .iter()
            .find(|s| s.predicate == name_id && s.direction == "fwd" && s.rows > 0)
            .expect("a forward `name` segment")
            .clone();

        // Control: it loads clean as written.
        ConvertedStore::open(&output)
            .expect("opens")
            .load_facts()
            .expect("clean store loads");

        // Re-encode with ONE changed value and DO NOT re-seal the descriptor.
        let path = output.join(&desc.path);
        let seg = read_segment(&path).expect("decode");
        let mut rows: Vec<PhysRow> = seg.rows.clone();
        let Value::Str(original) = rows[0].tuple[1].clone() else {
            panic!("a `name` value must be a Str")
        };
        rows[0].tuple[1] = Value::Str(format!("{original}!"));
        let (bytes, _meta) =
            encode_segment(seg.pred_id, seg.direction, seg.arity, &rows, 0).expect("re-encode");
        std::fs::write(&path, &bytes).expect("overwrite");

        let err = ConvertedStore::open(&output)
            .expect("manifest itself is untouched")
            .load_facts()
            .expect_err("unsealed byte edit must be rejected");
        assert!(
            err.contains("sha256 drift") || err.contains("length drift"),
            "expected an integrity rejection, got: {err}"
        );

        // Arity is checked against the CATALOG too: a segment re-encoded with a
        // different column count under the same descriptor is rejected even if
        // its bytes are correctly sealed.
        let mut narrow_rows: Vec<PhysRow> = seg.rows.clone();
        for r in narrow_rows.iter_mut() {
            r.tuple.truncate(1);
        }
        let (nbytes, nmeta) =
            encode_segment(seg.pred_id, seg.direction, 1, &narrow_rows, 0).expect("re-encode");
        std::fs::write(&path, &nbytes).expect("overwrite");
        let mut resealed = man.clone();
        for s in resealed.segments.iter_mut() {
            if s.path == desc.path {
                s.sha256 = nmeta.sha256.clone();
                s.bytes = nbytes.len() as u64;
            }
        }
        resealed.write_atomic(&output).expect("rewrite manifest");
        let err = ConvertedStore::open(&output)
            .expect("opens")
            .load_facts()
            .expect_err("arity drift must be rejected");
        assert!(err.contains("arity drift"), "expected arity rejection, got: {err}");
        let _ = std::fs::remove_file(input.join("LOCK"));
    }

    /// C1's conflict clause must not be satisfiable by emitting NO conflicts.
    /// Strip every `conflict/5` fact from a converted store, re-seal it, and C1
    /// must go inconsistent because the INPUT still carries a type-divergent
    /// subject that nothing accounts for.
    #[test]
    fn c1_rejects_a_store_that_dropped_its_conflicts() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let input = tmp.path().join("in");
        std::fs::create_dir(&input).expect("mkdir in");
        fixture_input(&input);
        let output = tmp.path().join("out");
        run(&RunOptions {
            input: input.clone(),
            output: output.clone(),
            verify_c1: true,
        })
        .expect("conversion succeeds");
        let _ = std::fs::remove_file(input.join("LOCK"));

        // Control: consistent, and NON-VACUOUSLY so — the input really does
        // carry a divergent subject and the store really does cover it.
        let base = verify_c1(&input, &output).expect("C1 runs");
        assert!(base.resolved_view_consistent);
        assert_eq!(base.input_multi_record_subjects, 1, "node 30");
        assert_eq!(base.input_type_divergent_subjects, 1);
        assert_eq!(base.type_conflict_subjects, 1);
        let _ = std::fs::remove_file(input.join("LOCK"));

        // Drop every conflict/5 row and re-seal, so the store is internally
        // consistent and merely SILENT about the conflict.
        let man = RoflManifest::read(&output).expect("manifest");
        let cid = man
            .catalog
            .iter()
            .find(|d| d.name == "conflict")
            .expect("conflict declared")
            .id;
        let mut stripped = man.clone();
        let mut emptied = 0usize;
        for s in stripped.segments.iter_mut() {
            if s.predicate != cid || s.rows == 0 {
                continue;
            }
            let path = output.join(&s.path);
            let seg = read_segment(&path).expect("decode");
            let (bytes, meta) =
                encode_segment(seg.pred_id, seg.direction, seg.arity, &[], 0).expect("re-encode");
            std::fs::write(&path, &bytes).expect("overwrite");
            s.rows = 0;
            s.sha256 = meta.sha256.clone();
            s.bytes = bytes.len() as u64;
            emptied += 1;
        }
        assert!(emptied > 0, "the fixture must have written a conflict segment");
        stripped.write_atomic(&output).expect("rewrite manifest");

        let after = verify_c1(&input, &output).expect("C1 still runs");
        assert_eq!(after.exceptions.len(), 0, "no conflicts left to join");
        assert_eq!(after.type_conflict_subjects, 0);
        assert_eq!(
            after.input_type_divergent_subjects, 1,
            "the INPUT is unchanged — the divergence is still there"
        );
        assert!(
            !after.resolved_view_consistent,
            "C1 accepted a store that silently dropped a Functional conflict"
        );
        let _ = std::fs::remove_file(input.join("LOCK"));
    }
}
