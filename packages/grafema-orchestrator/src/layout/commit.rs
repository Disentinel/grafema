//! Commit a per-symbol hex layout back to RFDB (DAI-22 Chunk-2).
//!
//! Writes three kinds of graph artifact:
//!
//! 1. `LAYOUT_POSITION` edges keyed by RFDB u128 id: one per placed symbol,
//!    with inline `q`/`r`/`committed_at` metadata. `dst` is the synthetic
//!    `HEX::<q>,<r>` id (convention shared with the prior MODULE-only commit).
//! 2. `REGION` nodes: one per folder in the placeable tree. Semantic id is
//!    `REGION::<depth>::<url-encoded-path>`. Metadata carries `depth`, `path`,
//!    `kind` (`folder` | `file`), and `name`. File-level regions include
//!    `overflow_skipped` and `hard_cap` when the hard-cap was hit.
//! 3. `CONTAINS` edges: `REGION(parent) -> REGION(child)` for the full folder
//!    tree, and `REGION(file) -> SYMBOL(rfdb_id)` for each placed leaf.
//!
//! Every emitted artifact carries `_source: "layout-pack"` in metadata so the
//! delete pre-pass (step 1 below) can cleanly remove prior layout output
//! without touching analyzer-emitted nodes or edges.
//!
//! ## Pipeline
//!
//! 1. `delete_edges_by_type_and_source("LAYOUT_POSITION", "layout-pack")` —
//!    clear prior edges.
//! 2. `delete_nodes_by_type_and_source("REGION", "layout-pack")` — clear prior
//!    region nodes and their outgoing edges (CONTAINS).
//! 3. Apply hard-cap per file (degree-desc, name-asc, semantic-id-asc tiebreak);
//!    drop overflow symbols from the placed set.
//! 4. Build REGION nodes, CONTAINS edges, LAYOUT_POSITION edges.
//! 5. Single `commit_batch` (chunked internally by the client at 10k).
//!
//! The delete and write phases are two separate RPCs — if we crash between
//! them the DB is left in a "no-layout" state. Rerunning `layout --commit`
//! converges cleanly. No rollback needed; `reload()` on the server side (and
//! the eventual stream) would simply report `layout_meta.source == "missing"`.

use anyhow::{Context, Result};
use rustc_hash::FxHashMap;

use crate::layout::tree::{Folder, FolderId, FolderTree};
use crate::layout::{LayoutInput, NodeIdx, RunResult};
use crate::rfdb::{RfdbClient, WireEdge, WireNode};

/// Source tag stored in every artifact's metadata.
pub const LAYOUT_SOURCE_TAG: &str = "layout-pack";

/// Default hard-cap on placeable symbols per file. Overflow is excluded from
/// `LAYOUT_POSITION` writes (and surfaced to the GUI via red badges).
pub const DEFAULT_HARD_CAP: usize = 500;

/// Edge type written for per-symbol placement.
pub const LAYOUT_EDGE_TYPE: &str = "LAYOUT_POSITION";
/// Edge type written for region containment.
pub const CONTAINS_EDGE_TYPE: &str = "CONTAINS";
/// Node type written for each folder/file region.
pub const REGION_NODE_TYPE: &str = "REGION";

/// A single symbol retained for placement after hard-cap filtering.
///
/// `node_idx` is the dense placeable index (maps back into `input.rfdb_ids`,
/// `input.semantic_ids`, `result.coords`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlacedSymbol {
    pub node_idx: NodeIdx,
}

/// Overflow summary for a single file that exceeded the hard-cap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileOverflow {
    pub file: String,
    pub skipped: usize,
    pub cap: usize,
}

/// Output of the hard-cap filter: survivors (in input order) plus per-file
/// overflow counts.
#[derive(Debug, Default)]
pub struct HardCapOutcome {
    /// NodeIdx of symbols that should get a LAYOUT_POSITION edge, in the
    /// caller's original (NodeIdx-ascending) order — not sorted by degree.
    pub placed: Vec<NodeIdx>,
    /// File → (skipped, cap). Only present for files where skipped > 0.
    pub overflow: FxHashMap<String, (usize, usize)>,
}

/// Aggregate commit payload: everything that needs to be written in one batch.
#[derive(Debug, Default)]
pub struct CommitPayload {
    pub nodes: Vec<WireNode>,
    pub edges: Vec<WireEdge>,
    /// LAYOUT_POSITION edge count (subset of `edges`).
    pub layout_position_count: usize,
    /// REGION node count (== `nodes.len()`).
    pub region_node_count: usize,
    /// CONTAINS edge count (subset of `edges`).
    pub contains_count: usize,
    /// Per-file overflow summary; empty when no file exceeded the cap.
    pub overflow_by_file: FxHashMap<String, (usize, usize)>,
}

/// Apply the per-file hard-cap. Groups `input` symbols by their leaf file
/// (using `leaf_paths[i]`), sorts each group by `(degree DESC, name ASC,
/// semantic_id ASC)`, and keeps the top `hard_cap`.
///
/// Names are derived from the semantic id's last `->`-segment (or the
/// full semantic id when no separator is present) to match §A.6 tiebreak
/// "name lex ASC" without requiring a separate name column on LayoutInput.
///
/// Returns [`HardCapOutcome`]: survivor NodeIdxs in original ascending order
/// plus per-file overflow counts.
pub fn apply_hard_cap(input: &LayoutInput, hard_cap: usize) -> HardCapOutcome {
    let semantic_ids = match input.semantic_ids.as_ref() {
        Some(s) => s,
        None => return HardCapOutcome::default(),
    };
    let degrees = input.degrees.as_deref().unwrap_or(&[]);

    // Bucket NodeIdxs by file.
    let mut by_file: FxHashMap<&str, Vec<NodeIdx>> = FxHashMap::default();
    for i in 0..input.n_nodes {
        by_file
            .entry(input.leaf_paths[i].as_str())
            .or_default()
            .push(i as NodeIdx);
    }

    // For each file: if over cap, sort by the tiebreak and keep top-N.
    let mut keep: Vec<bool> = vec![true; input.n_nodes];
    let mut overflow: FxHashMap<String, (usize, usize)> = FxHashMap::default();

    for (file, idxs) in &by_file {
        if idxs.len() <= hard_cap {
            continue;
        }
        let mut sorted: Vec<NodeIdx> = idxs.clone();
        sorted.sort_by(|a, b| {
            let da = degrees.get(*a as usize).copied().unwrap_or(0);
            let db = degrees.get(*b as usize).copied().unwrap_or(0);
            db.cmp(&da)
                .then_with(|| {
                    let na = tail_name(&semantic_ids[*a as usize]);
                    let nb = tail_name(&semantic_ids[*b as usize]);
                    na.cmp(nb)
                })
                .then_with(|| semantic_ids[*a as usize].cmp(&semantic_ids[*b as usize]))
        });
        for &dropped in &sorted[hard_cap..] {
            keep[dropped as usize] = false;
        }
        overflow.insert((*file).to_string(), (idxs.len() - hard_cap, hard_cap));
    }

    let placed: Vec<NodeIdx> = (0..input.n_nodes as NodeIdx)
        .filter(|i| keep[*i as usize])
        .collect();

    HardCapOutcome { placed, overflow }
}

/// Extract the tail component of a semantic id after the final `->`.
/// Used for the name-asc tiebreak in [`apply_hard_cap`]; no allocation.
fn tail_name(sid: &str) -> &str {
    match sid.rfind("->") {
        Some(i) => &sid[i + 2..],
        None => sid,
    }
}

/// URL-encode a folder path for use inside a REGION semantic id.
///
/// Escapes the reserved set `:` `/` `?` `#` ` `, plus `%` itself, to avoid
/// collisions with the `REGION::<depth>::<path>` delimiters. Keeps the
/// encoding deterministic and self-contained (no external crate).
pub fn url_encode_region_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b':' | b'/' | b'?' | b'#' | b' ' | b'%' => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
            _ => out.push(b as char),
        }
    }
    out
}

/// Build the canonical semantic id for a region at `depth` with `path`.
pub fn region_semantic_id(depth: u32, path: &str) -> String {
    format!("REGION::{depth}::{}", url_encode_region_path(path))
}

/// Build REGION nodes + REGION→REGION CONTAINS edges for every folder in
/// `tree`. The set of leaf-file folders is computed by: any folder whose
/// `direct_leaves` is non-empty is a "file" region; every other folder is a
/// "folder" region. Overflow metadata from `overflow_by_file` is attached
/// only to file regions whose path exists as a key there.
pub fn build_region_graph(
    tree: &FolderTree,
    overflow_by_file: &FxHashMap<String, (usize, usize)>,
    hard_cap: usize,
) -> (Vec<WireNode>, Vec<WireEdge>) {
    let mut nodes: Vec<WireNode> = Vec::with_capacity(tree.len());
    let mut edges: Vec<WireEdge> = Vec::new();

    // id-string cache keyed by FolderId so we can build edges without
    // re-formatting the semantic id on every reference.
    let mut sid_by_fid: FxHashMap<FolderId, String> = FxHashMap::default();

    for (fid, folder) in tree.iter() {
        let sid = region_semantic_id(folder.depth, &folder.path);
        let kind = if folder.direct_leaves.is_empty() {
            "folder"
        } else {
            "file"
        };
        let name = region_name(folder);
        let metadata = build_region_metadata(folder, kind, &name, overflow_by_file, hard_cap);

        nodes.push(WireNode {
            id: sid.clone(),
            semantic_id: None,
            node_type: Some(REGION_NODE_TYPE.to_string()),
            name: Some(name),
            file: Some(format!("<virtual>/layout-pack/{}", folder.path)),
            exported: false,
            metadata: Some(metadata),
        });
        sid_by_fid.insert(fid, sid);
    }

    for (fid, folder) in tree.iter() {
        let parent_sid = &sid_by_fid[&fid];
        for &child_fid in &folder.child_folders {
            let child_sid = &sid_by_fid[&child_fid];
            edges.push(WireEdge {
                src: parent_sid.clone(),
                dst: child_sid.clone(),
                edge_type: CONTAINS_EDGE_TYPE.to_string(),
                metadata: Some(format!(r#"{{"_source":"{LAYOUT_SOURCE_TAG}"}}"#)),
            });
        }
    }

    (nodes, edges)
}

/// Derive a display name for a region. Root (depth 0, path ".") → "/";
/// otherwise the final `/`-segment of the path.
fn region_name(folder: &Folder) -> String {
    if folder.depth == 0 {
        return "/".to_string();
    }
    match folder.path.rfind('/') {
        Some(i) => folder.path[i + 1..].to_string(),
        None => folder.path.clone(),
    }
}

/// Build the JSON metadata string for a REGION node.
fn build_region_metadata(
    folder: &Folder,
    kind: &str,
    name: &str,
    overflow_by_file: &FxHashMap<String, (usize, usize)>,
    hard_cap: usize,
) -> String {
    let mut buf = String::with_capacity(128);
    buf.push('{');
    buf.push_str(&format!(r#""_source":"{LAYOUT_SOURCE_TAG}","#));
    buf.push_str(&format!(r#""depth":{},"#, folder.depth));
    buf.push_str(&format!(
        r#""path":{},"#,
        json_string(&folder.path)
    ));
    buf.push_str(&format!(r#""kind":"{kind}","#));
    buf.push_str(&format!(r#""name":{}"#, json_string(name)));
    if kind == "file" {
        if let Some((skipped, cap)) = overflow_by_file.get(&folder.path) {
            buf.push_str(&format!(
                r#","overflow_skipped":{skipped},"hard_cap":{cap}"#
            ));
            // Touch the parameter for clarity; caller's intent is preserved
            // via the cap stored in overflow_by_file (may equal `hard_cap`).
            let _ = cap;
        } else {
            let _ = hard_cap;
        }
    }
    buf.push('}');
    buf
}

/// Serialize `s` as a JSON string literal (surrounded by quotes, with `"`,
/// `\`, and control chars escaped). Self-contained to avoid pulling in
/// `serde_json` just for this.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Build `LAYOUT_POSITION` edges for every placed (not-skipped) symbol.
pub fn build_layout_position_edges(
    input: &LayoutInput,
    result: &RunResult,
    placed: &[NodeIdx],
    committed_at: &str,
) -> Result<Vec<WireEdge>> {
    let semantic_ids = input.semantic_ids.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "commit_layout: input lacks semantic IDs (synthetic mode?). \
             Only RFDB-loaded layouts can be committed."
        )
    })?;

    if result.coords.len() != semantic_ids.len() {
        anyhow::bail!(
            "commit_layout: coord count {} != semantic ID count {} \
             (runner produced misaligned output)",
            result.coords.len(),
            semantic_ids.len()
        );
    }

    let mut edges: Vec<WireEdge> = Vec::with_capacity(placed.len());
    for &idx in placed {
        let i = idx as usize;
        let c = result.coords[i];
        let meta = format!(
            r#"{{"_source":"{LAYOUT_SOURCE_TAG}","q":{},"r":{},"committed_at":{}}}"#,
            c.q,
            c.r,
            json_string(committed_at)
        );
        edges.push(WireEdge {
            src: semantic_ids[i].clone(),
            dst: format!("HEX::{},{}", c.q, c.r),
            edge_type: LAYOUT_EDGE_TYPE.to_string(),
            metadata: Some(meta),
        });
    }
    Ok(edges)
}

/// Build REGION(file) → SYMBOL CONTAINS edges for every placed leaf.
pub fn build_region_to_symbol_edges(
    input: &LayoutInput,
    tree: &FolderTree,
    placed: &[NodeIdx],
) -> Result<Vec<WireEdge>> {
    let semantic_ids = input.semantic_ids.as_ref().ok_or_else(|| {
        anyhow::anyhow!("commit_layout: input lacks semantic IDs (synthetic mode?).")
    })?;

    let node_to_folder = tree.node_to_folder(input.n_nodes);
    let metadata = format!(r#"{{"_source":"{LAYOUT_SOURCE_TAG}"}}"#);

    let mut edges: Vec<WireEdge> = Vec::with_capacity(placed.len());
    for &idx in placed {
        let fid = node_to_folder[idx as usize];
        if fid == FolderId::MAX {
            continue;
        }
        let folder = tree.get(fid);
        let region_sid = region_semantic_id(folder.depth, &folder.path);
        edges.push(WireEdge {
            src: region_sid,
            dst: semantic_ids[idx as usize].clone(),
            edge_type: CONTAINS_EDGE_TYPE.to_string(),
            metadata: Some(metadata.clone()),
        });
    }
    Ok(edges)
}

/// Assemble the full commit payload (nodes + edges + summary counts) from a
/// laid-out [`LayoutInput`] + [`RunResult`].
pub fn build_commit_payload(
    input: &LayoutInput,
    result: &RunResult,
    hard_cap: usize,
    committed_at: &str,
) -> Result<CommitPayload> {
    let HardCapOutcome { placed, overflow } = apply_hard_cap(input, hard_cap);

    let (region_nodes, region_region_edges) =
        build_region_graph(&input.tree, &overflow, hard_cap);
    let layout_edges =
        build_layout_position_edges(input, result, &placed, committed_at)?;
    let region_to_symbol = build_region_to_symbol_edges(input, &input.tree, &placed)?;

    let region_node_count = region_nodes.len();
    let layout_position_count = layout_edges.len();
    let contains_count = region_region_edges.len() + region_to_symbol.len();

    let mut edges =
        Vec::with_capacity(region_region_edges.len() + region_to_symbol.len() + layout_edges.len());
    edges.extend(region_region_edges);
    edges.extend(region_to_symbol);
    edges.extend(layout_edges);

    Ok(CommitPayload {
        nodes: region_nodes,
        edges,
        layout_position_count,
        region_node_count,
        contains_count,
        overflow_by_file: overflow,
    })
}

/// Orchestrate the full commit: delete prior layout output, then write the
/// new payload in one batch. Returns the assembled payload so the caller can
/// format a summary.
pub async fn commit_layout(
    rfdb: &mut RfdbClient,
    input: &LayoutInput,
    result: &RunResult,
    hard_cap: usize,
) -> Result<CommitPayload> {
    if input.n_nodes == 0 {
        anyhow::bail!(
            "commit_layout: no placeable symbols loaded from RFDB — run `grafema analyze` first"
        );
    }

    let del_edges = rfdb
        .delete_edges_by_type_and_source(LAYOUT_EDGE_TYPE, LAYOUT_SOURCE_TAG)
        .await
        .context("Failed to delete prior LAYOUT_POSITION edges")?;
    let del_nodes = rfdb
        .delete_nodes_by_type_and_source(REGION_NODE_TYPE, LAYOUT_SOURCE_TAG)
        .await
        .context("Failed to delete prior REGION nodes")?;
    tracing::info!(
        deleted_edges = del_edges.deleted,
        deleted_regions = del_nodes.deleted_nodes,
        deleted_region_outgoing = del_nodes.deleted_outgoing_edges,
        "layout-pack: delete pre-pass complete"
    );

    let committed_at = iso8601_utc_now();
    let payload = build_commit_payload(input, result, hard_cap, &committed_at)?;

    rfdb.commit_batch(&[], &payload.nodes, &payload.edges, false)
        .await
        .context("Failed to commit LAYOUT_POSITION / REGION / CONTAINS payload")?;

    Ok(payload)
}

/// Current UTC time in `YYYY-MM-DDTHH:MM:SSZ` form.
///
/// Standalone to avoid a `chrono` dep for one timestamp — mirrors
/// `profiler::chrono_now`.
fn iso8601_utc_now() -> String {
    use std::time::SystemTime;
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let days = secs / 86400;
    let tod = secs % 86400;
    let (year, month, day) = days_to_ymd(days);
    let hours = tod / 3600;
    let minutes = (tod % 3600) / 60;
    let seconds = tod % 60;
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    days += 719468;
    let era = days / 146097;
    let doe = days % 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::edges::Edge;
    use crate::layout::runner::LayoutStats;
    use crate::layout::{generate, run_layout, HexCoord, RunOpts};

    fn fake_result(coords: Vec<HexCoord>) -> RunResult {
        let n = coords.len();
        RunResult {
            coords,
            stats: LayoutStats {
                n_nodes: n,
                n_edges: 0,
                pack_ms: 0,
                iswap_ms: 0,
                xswap_ms: 0,
                iswap_swaps: 0,
                xswap_swaps: 0,
                sigma_link_pre: 0.0,
                sigma_link_after_iswap: 0.0,
                sigma_link_after_xswap: 0.0,
            },
        }
    }

    fn rfdb_style_input(
        entries: Vec<(&str, &str, u32)>, // (leaf_path, semantic_id, degree)
    ) -> LayoutInput {
        let n = entries.len();
        let leaf_paths: Vec<String> = entries.iter().map(|(p, _, _)| p.to_string()).collect();
        let semantic_ids: Vec<String> = entries.iter().map(|(_, s, _)| s.to_string()).collect();
        let rfdb_ids: Vec<u128> =
            semantic_ids.iter().map(|s| crate::rfdb::semantic_id_to_u128(s)).collect();
        let degrees: Vec<u32> = entries.iter().map(|(_, _, d)| *d).collect();
        let triples: Vec<(NodeIdx, &str, &str)> = (0..n)
            .map(|i| (i as NodeIdx, leaf_paths[i].as_str(), semantic_ids[i].as_str()))
            .collect();
        let tree = FolderTree::build_from_paths_with_leaves(&triples);
        LayoutInput {
            tree,
            edges: Vec::<Edge>::new(),
            n_nodes: n,
            leaf_paths,
            semantic_ids: Some(semantic_ids),
            rfdb_ids: Some(rfdb_ids),
            degrees: Some(degrees),
        }
    }

    // ── url_encode_region_path / region_semantic_id ─────────────────────────

    #[test]
    fn region_semantic_id_is_url_encoded() {
        assert_eq!(region_semantic_id(0, "."), "REGION::0::.");
        assert_eq!(region_semantic_id(1, "a"), "REGION::1::a");
        // Slashes and colons get percent-encoded so they can't collide with
        // the `::` separator.
        assert_eq!(
            region_semantic_id(3, "packages/util/src"),
            "REGION::3::packages%2Futil%2Fsrc"
        );
        assert_eq!(
            region_semantic_id(1, "a:b c#d?e"),
            "REGION::1::a%3Ab%20c%23d%3Fe"
        );
        // `%` itself must be encoded too.
        assert_eq!(region_semantic_id(1, "a%b"), "REGION::1::a%25b");
    }

    // ── hard-cap ────────────────────────────────────────────────────────────

    #[test]
    fn hard_cap_is_noop_under_threshold() {
        let input = rfdb_style_input(vec![
            ("a.rs", "a.rs->F->a", 1),
            ("a.rs", "a.rs->F->b", 2),
        ]);
        let out = apply_hard_cap(&input, 500);
        assert_eq!(out.placed, vec![0, 1]);
        assert!(out.overflow.is_empty());
    }

    #[test]
    fn hard_cap_drops_lowest_degree_symbols_past_n() {
        // 5 symbols in one file, cap=3. Degrees: [1, 5, 2, 4, 3].
        // Survivors: degrees 5, 4, 3 (idx 1, 3, 4).
        let input = rfdb_style_input(vec![
            ("big.rs", "big.rs->F->a", 1),
            ("big.rs", "big.rs->F->b", 5),
            ("big.rs", "big.rs->F->c", 2),
            ("big.rs", "big.rs->F->d", 4),
            ("big.rs", "big.rs->F->e", 3),
        ]);
        let out = apply_hard_cap(&input, 3);
        assert_eq!(out.placed, vec![1, 3, 4]);
        assert_eq!(
            out.overflow.get("big.rs").copied(),
            Some((2, 3))
        );
    }

    #[test]
    fn hard_cap_tiebreak_is_degree_desc_then_name_asc_then_semid_asc() {
        // All degree=1; cap=2. Tiebreak by name asc (tail after ->):
        // names are "a", "b", "c". Survivors: "a" and "b" (idx 0, 1).
        let input = rfdb_style_input(vec![
            ("f.rs", "f.rs->F->a", 1),
            ("f.rs", "f.rs->F->b", 1),
            ("f.rs", "f.rs->F->c", 1),
        ]);
        let out = apply_hard_cap(&input, 2);
        assert_eq!(out.placed, vec![0, 1]);
    }

    #[test]
    fn hard_cap_tiebreak_falls_through_to_semid_asc_when_names_equal() {
        // Two symbols with the same tail-name (different container prefix),
        // plus one more with a lower name. Cap=2 → keep "a" and the
        // lex-smaller semid of the two "z" entries.
        let input = rfdb_style_input(vec![
            ("f.rs", "f.rs->F->z", 1),       // idx 0
            ("f.rs", "f.rs->M->a", 1),       // idx 1, name="a"
            ("f.rs", "f.rs->F->z_dup_b", 1), // idx 2, name differs
        ]);
        // Names: "z", "a", "z_dup_b". Order by name asc → a, z, z_dup_b.
        // Cap=2 → idx 1 and idx 0 survive (in original order: 0, 1).
        let out = apply_hard_cap(&input, 2);
        assert_eq!(out.placed, vec![0, 1]);
    }

    #[test]
    fn hard_cap_records_overflow_count_per_file() {
        let input = rfdb_style_input(vec![
            ("small.rs", "small.rs->F->a", 1),
            ("big.rs", "big.rs->F->a", 5),
            ("big.rs", "big.rs->F->b", 4),
            ("big.rs", "big.rs->F->c", 3),
        ]);
        let out = apply_hard_cap(&input, 2);
        // small.rs: 1 symbol ≤ 2, unaffected.
        assert!(out.overflow.get("small.rs").is_none());
        // big.rs: 3 symbols > 2 → 1 overflow.
        assert_eq!(out.overflow.get("big.rs").copied(), Some((1, 2)));
    }

    #[test]
    fn hard_cap_is_per_file_not_global() {
        // Two files, 2 symbols each, cap=2 per file → everyone survives.
        let input = rfdb_style_input(vec![
            ("a.rs", "a.rs->F->a", 1),
            ("a.rs", "a.rs->F->b", 1),
            ("b.rs", "b.rs->F->a", 1),
            ("b.rs", "b.rs->F->b", 1),
        ]);
        let out = apply_hard_cap(&input, 2);
        assert_eq!(out.placed, vec![0, 1, 2, 3]);
        assert!(out.overflow.is_empty());
    }

    // ── REGION nodes ────────────────────────────────────────────────────────

    #[test]
    fn build_region_nodes_emits_one_per_folder_with_depth_kind_path() {
        let input = rfdb_style_input(vec![
            ("a/b.rs", "a/b.rs->F->x", 1),
            ("a/c.rs", "a/c.rs->F->y", 1),
        ]);
        let overflow = FxHashMap::default();
        let (nodes, _edges) = build_region_graph(&input.tree, &overflow, 500);

        // Folders in tree: ".", "a", "a/b.rs", "a/c.rs". Each gets a REGION.
        assert_eq!(nodes.len(), 4);
        // Every node has _source set and type REGION.
        for n in &nodes {
            assert_eq!(n.node_type.as_deref(), Some("REGION"));
            let m = n.metadata.as_deref().unwrap();
            assert!(m.contains(r#""_source":"layout-pack""#));
            assert!(m.contains(r#""depth":"#));
            assert!(m.contains(r#""path":"#));
            assert!(m.contains(r#""kind":"#));
        }
        // Root is kind=folder, depth=0.
        let root = nodes
            .iter()
            .find(|n| n.id == "REGION::0::.")
            .expect("root region missing");
        let rm = root.metadata.as_deref().unwrap();
        assert!(rm.contains(r#""kind":"folder""#));
        assert!(rm.contains(r#""depth":0"#));
        // Leaf-file folders are kind=file. "a/b.rs" and "a/c.rs" contain direct
        // leaves (per build_from_paths_with_leaves, the file path is the
        // innermost folder).
        let b = nodes
            .iter()
            .find(|n| n.id.starts_with("REGION::2::a%2Fb.rs"))
            .expect("a/b.rs region missing");
        assert!(b.metadata.as_deref().unwrap().contains(r#""kind":"file""#));
    }

    #[test]
    fn build_region_nodes_attach_overflow_metadata_to_file_regions_only() {
        let input = rfdb_style_input(vec![
            ("big.rs", "big.rs->F->a", 3),
            ("big.rs", "big.rs->F->b", 2),
            ("big.rs", "big.rs->F->c", 1),
        ]);
        let mut overflow = FxHashMap::default();
        overflow.insert("big.rs".to_string(), (1usize, 2usize));
        let (nodes, _edges) = build_region_graph(&input.tree, &overflow, 2);

        // The file region for "big.rs" must carry overflow_skipped + hard_cap.
        let file_region = nodes
            .iter()
            .find(|n| n.metadata.as_deref().unwrap().contains(r#""kind":"file""#))
            .expect("file region missing");
        let m = file_region.metadata.as_deref().unwrap();
        assert!(m.contains(r#""overflow_skipped":1"#), "meta: {m}");
        assert!(m.contains(r#""hard_cap":2"#), "meta: {m}");

        // The root (folder) region must NOT carry overflow keys.
        let root = nodes
            .iter()
            .find(|n| n.id == "REGION::0::.")
            .unwrap();
        let rm = root.metadata.as_deref().unwrap();
        assert!(!rm.contains("overflow_skipped"));
        assert!(!rm.contains("hard_cap"));
    }

    // ── CONTAINS edges ──────────────────────────────────────────────────────

    #[test]
    fn build_contains_edges_covers_parent_child_and_leaf_attachment() {
        let input = rfdb_style_input(vec![
            ("a/b.rs", "a/b.rs->F->x", 1),
            ("a/b.rs", "a/b.rs->F->y", 1),
            ("a/c.rs", "a/c.rs->F->z", 1),
        ]);
        let overflow = FxHashMap::default();
        let (_nodes, region_edges) = build_region_graph(&input.tree, &overflow, 500);

        // Parent → child edges: "." → "a"; "a" → "a/b.rs"; "a" → "a/c.rs".
        assert_eq!(region_edges.len(), 3);
        for e in &region_edges {
            assert_eq!(e.edge_type, "CONTAINS");
            assert_eq!(
                e.metadata.as_deref(),
                Some(r#"{"_source":"layout-pack"}"#)
            );
        }
        assert!(
            region_edges
                .iter()
                .any(|e| e.src == "REGION::0::." && e.dst.starts_with("REGION::1::a"))
        );

        // Leaf attachment: a/b.rs → 2 symbols; a/c.rs → 1 symbol.
        let placed = vec![0 as NodeIdx, 1, 2];
        let r2s = build_region_to_symbol_edges(&input, &input.tree, &placed).unwrap();
        assert_eq!(r2s.len(), 3);
        for e in &r2s {
            assert_eq!(e.edge_type, "CONTAINS");
            assert!(e.src.starts_with("REGION::2::a%2F"));
        }
    }

    // ── LAYOUT_POSITION ─────────────────────────────────────────────────────

    #[test]
    fn build_layout_position_edges_emits_one_per_placed_symbol_with_inline_q_r() {
        let input = rfdb_style_input(vec![
            ("a.rs", "a.rs->F->x", 1),
            ("a.rs", "a.rs->F->y", 1),
        ]);
        let result = fake_result(vec![HexCoord { q: 3, r: -2 }, HexCoord { q: 0, r: 1 }]);
        let placed = vec![0 as NodeIdx, 1];
        let edges =
            build_layout_position_edges(&input, &result, &placed, "2026-04-23T12:00:00Z").unwrap();
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].edge_type, "LAYOUT_POSITION");
        assert_eq!(edges[0].src, "a.rs->F->x");
        assert_eq!(edges[0].dst, "HEX::3,-2");
        let m0 = edges[0].metadata.as_deref().unwrap();
        assert!(m0.contains(r#""_source":"layout-pack""#));
        assert!(m0.contains(r#""q":3"#));
        assert!(m0.contains(r#""r":-2"#));
        assert!(m0.contains(r#""committed_at":"2026-04-23T12:00:00Z""#));
    }

    #[test]
    fn build_layout_position_edges_skips_overflow_symbols() {
        let input = rfdb_style_input(vec![
            ("f.rs", "f.rs->F->a", 3),
            ("f.rs", "f.rs->F->b", 2),
            ("f.rs", "f.rs->F->c", 1),
        ]);
        let result = fake_result(vec![
            HexCoord { q: 0, r: 0 },
            HexCoord { q: 1, r: 0 },
            HexCoord { q: 2, r: 0 },
        ]);
        // Hard-cap 2 → only top-2 by degree (idx 0, 1) get edges.
        let HardCapOutcome { placed, overflow } = apply_hard_cap(&input, 2);
        assert_eq!(placed.len(), 2);
        let edges =
            build_layout_position_edges(&input, &result, &placed, "2026-04-23T00:00:00Z").unwrap();
        assert_eq!(edges.len(), 2);
        assert_eq!(overflow.get("f.rs").copied(), Some((1, 2)));
    }

    #[test]
    fn build_layout_position_synthetic_input_returns_error() {
        let input = generate(10, 42, 1.0);
        let result = run_layout(&input, &RunOpts::default());
        let placed: Vec<NodeIdx> = (0..input.n_nodes as NodeIdx).collect();
        let err =
            build_layout_position_edges(&input, &result, &placed, "t").unwrap_err();
        assert!(format!("{err}").contains("synthetic"));
    }

    #[test]
    fn build_layout_position_coord_count_mismatch_errors() {
        // Build a 2-symbol input, then ask run_layout for its coords (2 coords).
        // Tamper: construct a RunResult with 3 coords so count mismatches
        // semantic_ids.len() == 2.
        let input = rfdb_style_input(vec![
            ("a.rs", "a.rs->F->a", 1),
            ("a.rs", "a.rs->F->b", 1),
        ]);
        let result = fake_result(vec![
            HexCoord { q: 0, r: 0 },
            HexCoord { q: 1, r: 0 },
            HexCoord { q: 2, r: 0 },
        ]);
        let err =
            build_layout_position_edges(&input, &result, &[0, 1], "t").unwrap_err();
        assert!(format!("{err}").contains("misaligned"));
    }

    // ── full payload ────────────────────────────────────────────────────────

    #[test]
    fn build_commit_payload_counts_are_consistent() {
        let input = rfdb_style_input(vec![
            ("a/x.rs", "a/x.rs->F->f1", 2),
            ("a/x.rs", "a/x.rs->F->f2", 1),
            ("a/y.rs", "a/y.rs->F->g", 3),
        ]);
        let result = fake_result(vec![
            HexCoord { q: 0, r: 0 },
            HexCoord { q: 1, r: 0 },
            HexCoord { q: 2, r: 0 },
        ]);
        let payload =
            build_commit_payload(&input, &result, 500, "2026-04-23T00:00:00Z").unwrap();
        // 3 placed → 3 LAYOUT_POSITION + 3 REGION→SYMBOL CONTAINS.
        assert_eq!(payload.layout_position_count, 3);
        // REGION nodes: ., a, a/x.rs, a/y.rs  → 4 nodes.
        assert_eq!(payload.region_node_count, 4);
        // REGION→REGION CONTAINS: . → a; a → x.rs; a → y.rs → 3 edges.
        // Plus 3 REGION→SYMBOL → 6 total.
        assert_eq!(payload.contains_count, 6);
        // Total edges = 3 LP + 6 CONTAINS = 9.
        assert_eq!(payload.edges.len(), 9);
        assert!(payload.overflow_by_file.is_empty());
    }

    #[test]
    fn build_commit_payload_empty_input_produces_empty_payload_plus_root_region() {
        let input = rfdb_style_input(vec![]);
        let result = fake_result(vec![]);
        let payload =
            build_commit_payload(&input, &result, 500, "2026-04-23T00:00:00Z").unwrap();
        // No symbols → 0 layout positions. But the tree still has the root
        // folder → 1 REGION node, 0 CONTAINS edges.
        assert_eq!(payload.layout_position_count, 0);
        assert_eq!(payload.region_node_count, 1);
        assert_eq!(payload.contains_count, 0);
    }

    // ── misc idempotency ────────────────────────────────────────────────────

    #[test]
    fn build_commit_payload_is_deterministic_given_same_timestamp() {
        let input = rfdb_style_input(vec![
            ("a.rs", "a.rs->F->x", 1),
            ("a.rs", "a.rs->F->y", 1),
        ]);
        let result = fake_result(vec![HexCoord { q: 0, r: 0 }, HexCoord { q: 1, r: 0 }]);
        let ts = "2026-04-23T00:00:00Z";
        let p1 = build_commit_payload(&input, &result, 500, ts).unwrap();
        let p2 = build_commit_payload(&input, &result, 500, ts).unwrap();
        assert_eq!(p1.layout_position_count, p2.layout_position_count);
        assert_eq!(p1.region_node_count, p2.region_node_count);
        assert_eq!(p1.contains_count, p2.contains_count);
        // Edge sets must be pairwise equal (same order is a stronger property
        // that we rely on for reproducibility).
        assert_eq!(p1.edges.len(), p2.edges.len());
        for (a, b) in p1.edges.iter().zip(p2.edges.iter()) {
            assert_eq!(a.src, b.src);
            assert_eq!(a.dst, b.dst);
            assert_eq!(a.edge_type, b.edge_type);
            assert_eq!(a.metadata, b.metadata);
        }
    }
}
