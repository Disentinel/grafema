//! RFDB-backed input loader for the layout pipeline.
//!
//! Queries MODULE nodes (one per source file) and MODULE→MODULE DEPENDS_ON
//! edges from a live RFDB and folds them into a [`LayoutInput`] — the same
//! shape produced by [`super::synthetic::generate`]. After this step the
//! pack → iswap → xswap pipeline runs against real graph data.
//!
//! ## Pipeline
//!
//! 1. `query_nodes_by_type("MODULE")` — every MODULE node with its `file` field.
//! 2. Build `leaf_paths` (one per file) and `id_to_idx` (semantic id →
//!    [`NodeIdx`]). MODULE nodes without a `file` are silently skipped with a
//!    `tracing::warn!` — defensive, shouldn't happen in healthy RFDBs.
//! 3. `FolderTree::build_from_paths` from the path list.
//! 4. Datalog query `edge(Src, Dst, "DEPENDS_ON")` — each binding's `Src`/`Dst`
//!    is a JSON string holding the source/target semantic id. Resolve through
//!    `id_to_idx`; skip pairs whose endpoint is not in the MODULE set
//!    (defensive — should be impossible if DEPENDS_ON was derived correctly).
//!    Self-loops (`src == dst`) are dropped.
//! 5. Wrap into [`LayoutInput`] with `weight = 1.0` on every edge.
//!
//! ## Determinism
//!
//! `query_nodes_by_type` returns nodes in RFDB's storage iteration order
//! (deterministic per-database, but order is not lexicographic). We preserve
//! that order — `NodeIdx` values match the order RFDB emits them — so two
//! runs against the same RFDB produce byte-identical [`LayoutInput`]s. If
//! you need cross-RFDB stability (e.g. comparing snapshots from different
//! analysis runs), pre-sort `leaf_paths` lexicographically before calling
//! `FolderTree::build_from_paths` — but `pack`/`iswap`/`xswap` are themselves
//! deterministic on input, so single-RFDB stability is what callers care about.

use anyhow::{Context, Result};
use rustc_hash::FxHashMap;

use crate::layout::synthetic::LayoutInput;
use crate::layout::{Edge, FolderTree, NodeIdx};
use crate::rfdb::{DatalogResult, RfdbClient, WireNode};

/// Query the live RFDB and produce a [`LayoutInput`] ready for `run_layout`.
///
/// See module docs for the full pipeline. On any RFDB error this returns
/// `Err` (never panics) — the caller decides whether to retry, fall back to
/// `--synthetic`, or surface the error to the user.
pub async fn load_from_rfdb(rfdb: &mut RfdbClient) -> Result<LayoutInput> {
    let modules = rfdb
        .query_nodes_by_type("MODULE")
        .await
        .context("Failed to query MODULE nodes")?;

    let depends_on = rfdb
        .datalog_query(r#"violation(Src, Dst) :- edge(Src, Dst, "DEPENDS_ON")."#)
        .await
        .context("Failed to query DEPENDS_ON edges")?;

    Ok(build_layout_input(&modules, &depends_on))
}

/// Pure transformation: `(modules, depends_on)` → [`LayoutInput`].
///
/// Split out from [`load_from_rfdb`] so the post-query logic is unit-testable
/// without booting an RFDB server. All defensive logging (skips for missing
/// `file`, unknown semantic ids, self-loops) lives here.
pub(crate) fn build_layout_input(
    modules: &[WireNode],
    depends_on: &[DatalogResult],
) -> LayoutInput {
    // ── Build leaf path list, semantic ID list, and the id → NodeIdx index ─
    // We preserve RFDB's iteration order — same DB → same NodeIdx assignment
    // (see module docs on Determinism). `semantic_ids[i]` is the MODULE
    // semantic id for leaf `i`; kept parallel to `leaf_paths` so the
    // commit step can emit `LAYOUT_POSITION` edges keyed by MODULE id.
    let mut leaf_paths: Vec<String> = Vec::with_capacity(modules.len());
    let mut semantic_ids: Vec<String> = Vec::with_capacity(modules.len());
    let mut id_to_idx: FxHashMap<String, NodeIdx> = FxHashMap::default();
    id_to_idx.reserve(modules.len());

    for module in modules {
        let Some(ref file) = module.file else {
            tracing::warn!(
                module_id = %module.id,
                "MODULE node has no file field — skipping (defensive: shouldn't happen in healthy RFDB)"
            );
            continue;
        };
        let idx = leaf_paths.len() as NodeIdx;
        leaf_paths.push(file.clone());
        semantic_ids.push(module.id.clone());
        id_to_idx.insert(module.id.clone(), idx);
    }

    // ── Build the folder tree from the (NodeIdx, path) pairs ───────────────
    let pairs: Vec<(NodeIdx, &str)> = leaf_paths
        .iter()
        .enumerate()
        .map(|(i, p)| (i as NodeIdx, p.as_str()))
        .collect();
    let tree = FolderTree::build_from_paths(&pairs);

    // ── Resolve DEPENDS_ON pairs to NodeIdx and emit edges ─────────────────
    // Datalog binding shape: each row's `bindings` map has keys "Src"/"Dst"
    // (matching the rule head `violation(Src, Dst)`). Values are JSON strings
    // (semantic ids). Anything else is a protocol bug — log + skip.
    let mut edges: Vec<Edge> = Vec::with_capacity(depends_on.len());
    for row in depends_on {
        let src_id = match binding_str(row, "Src") {
            Some(s) => s,
            None => {
                tracing::warn!(
                    bindings = ?row.bindings,
                    "DEPENDS_ON row has no `Src` binding (or non-string) — skipping"
                );
                continue;
            }
        };
        let dst_id = match binding_str(row, "Dst") {
            Some(s) => s,
            None => {
                tracing::warn!(
                    bindings = ?row.bindings,
                    "DEPENDS_ON row has no `Dst` binding (or non-string) — skipping"
                );
                continue;
            }
        };

        let Some(&src_idx) = id_to_idx.get(src_id) else {
            tracing::warn!(
                src_id,
                "DEPENDS_ON src not in MODULE set — skipping (defensive)"
            );
            continue;
        };
        let Some(&dst_idx) = id_to_idx.get(dst_id) else {
            tracing::warn!(
                dst_id,
                "DEPENDS_ON dst not in MODULE set — skipping (defensive)"
            );
            continue;
        };

        if src_idx == dst_idx {
            tracing::warn!(
                src_id,
                "DEPENDS_ON self-loop (src == dst) — skipping"
            );
            continue;
        }

        edges.push(Edge {
            src: src_idx,
            dst: dst_idx,
            weight: 1.0,
        });
    }

    LayoutInput {
        n_nodes: leaf_paths.len(),
        tree,
        edges,
        leaf_paths,
        semantic_ids: Some(semantic_ids),
    }
}

/// Extract a string-typed binding from a Datalog result row.
///
/// Returns `None` if the key is missing or the value is not a JSON string.
fn binding_str<'a>(row: &'a DatalogResult, key: &str) -> Option<&'a str> {
    row.bindings.get(key).and_then(|v| v.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Helper: build a MODULE WireNode with the given semantic id and file.
    fn module(id: &str, file: Option<&str>) -> WireNode {
        WireNode {
            id: id.to_string(),
            semantic_id: None,
            node_type: Some("MODULE".to_string()),
            name: None,
            file: file.map(|s| s.to_string()),
            exported: false,
            metadata: None,
        }
    }

    /// Helper: build a Datalog result row binding `Src`/`Dst` to the given strings.
    fn dep(src: &str, dst: &str) -> DatalogResult {
        let mut bindings = HashMap::new();
        bindings.insert("Src".to_string(), serde_json::Value::String(src.to_string()));
        bindings.insert("Dst".to_string(), serde_json::Value::String(dst.to_string()));
        DatalogResult { bindings }
    }

    #[test]
    fn empty_modules_produce_empty_input() {
        let input = build_layout_input(&[], &[]);
        assert_eq!(input.n_nodes, 0);
        assert!(input.leaf_paths.is_empty());
        assert!(input.edges.is_empty());
        // Tree contains only the synthetic root.
        assert_eq!(input.tree.len(), 1);
        assert_eq!(input.tree.get(input.tree.root()).path, ".");
    }

    #[test]
    fn three_modules_with_one_depends_on_edge() {
        // 3 MODULE nodes, paths `a.rs`, `a/b.rs`, `a/c.rs` →
        // tree should have 2 folders (root `.`, and `a`).
        let modules = vec![
            module("mod#a.rs", Some("a.rs")),
            module("mod#a/b.rs", Some("a/b.rs")),
            module("mod#a/c.rs", Some("a/c.rs")),
        ];
        // One edge: a.rs → a/b.rs
        let edges = vec![dep("mod#a.rs", "mod#a/b.rs")];

        let input = build_layout_input(&modules, &edges);

        assert_eq!(input.n_nodes, 3);
        assert_eq!(input.leaf_paths, vec!["a.rs", "a/b.rs", "a/c.rs"]);
        // Tree: . (root) + a → 2 folders.
        assert_eq!(input.tree.len(), 2);
        assert!(input.tree.folder_id(".").is_some());
        assert!(input.tree.folder_id("a").is_some());
        // Edge resolution: src=0 (a.rs), dst=1 (a/b.rs), weight 1.0.
        assert_eq!(input.edges.len(), 1);
        let e = &input.edges[0];
        assert_eq!(e.src, 0);
        assert_eq!(e.dst, 1);
        assert_eq!(e.weight, 1.0);
    }

    #[test]
    fn module_without_file_is_skipped() {
        // 3 MODULEs but the middle one has no `file` field.
        // Expected: 2 leaf paths, the no-file module produces no NodeIdx.
        let modules = vec![
            module("mod#a.rs", Some("a.rs")),
            module("mod#orphan", None),
            module("mod#b.rs", Some("b.rs")),
        ];
        let input = build_layout_input(&modules, &[]);
        assert_eq!(input.n_nodes, 2);
        assert_eq!(input.leaf_paths, vec!["a.rs", "b.rs"]);
        assert!(input.edges.is_empty());
    }

    #[test]
    fn unknown_semantic_id_in_depends_on_is_skipped() {
        let modules = vec![
            module("mod#a.rs", Some("a.rs")),
            module("mod#b.rs", Some("b.rs")),
        ];
        let edges = vec![
            // Valid edge.
            dep("mod#a.rs", "mod#b.rs"),
            // Bad src — not in module set.
            dep("mod#nope", "mod#b.rs"),
            // Bad dst — not in module set.
            dep("mod#a.rs", "mod#also-nope"),
        ];
        let input = build_layout_input(&modules, &edges);
        assert_eq!(input.edges.len(), 1, "only the valid pair should survive");
        assert_eq!(input.edges[0].src, 0);
        assert_eq!(input.edges[0].dst, 1);
    }

    #[test]
    fn self_loop_depends_on_is_skipped() {
        let modules = vec![module("mod#a.rs", Some("a.rs"))];
        let edges = vec![dep("mod#a.rs", "mod#a.rs")];
        let input = build_layout_input(&modules, &edges);
        assert!(input.edges.is_empty(), "self-loops must be skipped");
    }

    #[test]
    fn depends_on_with_missing_binding_key_is_skipped() {
        let modules = vec![
            module("mod#a.rs", Some("a.rs")),
            module("mod#b.rs", Some("b.rs")),
        ];
        // Row with no `Src` key.
        let mut bad_bindings = HashMap::new();
        bad_bindings.insert(
            "Dst".to_string(),
            serde_json::Value::String("mod#b.rs".to_string()),
        );
        let edges = vec![DatalogResult { bindings: bad_bindings }];
        let input = build_layout_input(&modules, &edges);
        assert!(input.edges.is_empty());
    }

    #[test]
    fn depends_on_with_non_string_binding_is_skipped() {
        let modules = vec![
            module("mod#a.rs", Some("a.rs")),
            module("mod#b.rs", Some("b.rs")),
        ];
        // Row where `Src` is a number, not a string.
        let mut weird_bindings = HashMap::new();
        weird_bindings.insert("Src".to_string(), serde_json::Value::from(42));
        weird_bindings.insert(
            "Dst".to_string(),
            serde_json::Value::String("mod#b.rs".to_string()),
        );
        let edges = vec![DatalogResult { bindings: weird_bindings }];
        let input = build_layout_input(&modules, &edges);
        assert!(input.edges.is_empty());
    }

    #[test]
    fn nodeidx_assignment_matches_module_iteration_order() {
        // Sanity-check: the order in which modules appear in the input slice
        // determines NodeIdx assignment. Caller relies on this for stability
        // across runs against the same RFDB.
        let modules = vec![
            module("mod#z.rs", Some("z.rs")),
            module("mod#a.rs", Some("a.rs")),
            module("mod#m.rs", Some("m.rs")),
        ];
        let input = build_layout_input(&modules, &[]);
        // NOT lex-sorted — preserves input order.
        assert_eq!(input.leaf_paths, vec!["z.rs", "a.rs", "m.rs"]);
    }

    #[test]
    fn duplicate_depends_on_pairs_emit_duplicate_edges() {
        // We don't dedup — the synthetic generator doesn't either, and the
        // pack/swap phases tolerate (and weight by) duplicates. Documenting
        // the behaviour so it's not assumed.
        let modules = vec![
            module("mod#a.rs", Some("a.rs")),
            module("mod#b.rs", Some("b.rs")),
        ];
        let edges = vec![
            dep("mod#a.rs", "mod#b.rs"),
            dep("mod#a.rs", "mod#b.rs"),
        ];
        let input = build_layout_input(&modules, &edges);
        assert_eq!(input.edges.len(), 2);
    }
}
