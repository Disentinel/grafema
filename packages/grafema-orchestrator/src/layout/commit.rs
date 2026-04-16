//! Commit a computed layout back to RFDB as `LAYOUT_POSITION` edges.
//!
//! Pattern mirrors the DEPENDS_ON commit in `main.rs` (the orchestrator's
//! "derived edge" lifecycle): no node mutation, no metadata pollution on
//! existing MODULE nodes — instead we write one edge per leaf, with a
//! synthetic `HEX::<q>,<r>` destination that makes the layout queryable
//! via Datalog (`edge(M, _, "LAYOUT_POSITION")` → all placed modules).
//!
//! ## Why a synthetic dst, not metadata?
//!
//! Storing `{q, r}` in `MODULE.metadata` would conflict with any existing
//! analyzer that touches metadata, and would couple layout into the analysis
//! pipeline. Edges to a synthetic node keep the layout strictly downstream:
//! `grafema analyze` produces MODULE nodes; `layout --commit` adds edges;
//! deleting all `LAYOUT_POSITION` edges removes the layout cleanly.
//!
//! ## Synthetic destination ID format
//!
//! `HEX::<q>,<r>` — `<q>` and `<r>` are signed integers (axial hex coords).
//! `HEX::` prefix mirrors the existing `GLOBAL::`/`HASKELL_GLOBAL::` virtual
//! node convention used by the resolvers, so it's recognisable as a synthetic
//! ID rather than a path. We do **not** create the HEX nodes ahead of time —
//! RFDB's `commit_batch` accepts edges referencing nodes that don't exist as
//! first-class records, and Datalog queries treat them as opaque IDs anyway.
//!
//! ## Synthetic-mode guard
//!
//! [`commit_layout`] is only meaningful when `LayoutInput` came from RFDB
//! (`--socket` mode). For synthetic mode (`--synthetic N`), `leaf_paths` are
//! generated from a vocabulary and don't correspond to any real semantic ID.
//! We refuse to commit in that case (returns `Err` rather than silently
//! producing garbage edges).

use anyhow::{Context, Result};

use crate::layout::{LayoutInput, RunResult};
use crate::rfdb::{RfdbClient, WireEdge};

/// Source tag stored in every `LAYOUT_POSITION` edge's metadata. Mirrors the
/// `_source` convention used by the DEPENDS_ON commit in `main.rs`.
const LAYOUT_METADATA_JSON: &str = r#"{"_source":"layout-pack"}"#;

/// Edge type written by [`commit_layout`].
const LAYOUT_EDGE_TYPE: &str = "LAYOUT_POSITION";

/// Build the `LAYOUT_POSITION` edge list for a computed layout.
///
/// Pure function — no RFDB I/O, no allocation beyond the returned `Vec`.
/// Split out from [`commit_layout`] so it's unit-testable without booting
/// an RFDB server.
///
/// One edge per node:
///   * `src` = MODULE semantic id (from `input.semantic_ids[i]`)
///   * `dst` = `HEX::<q>,<r>` synthetic id
///   * `edge_type` = `"LAYOUT_POSITION"`
///   * `metadata` = `{"_source":"layout-pack"}`
///
/// Returns `Err` when `input.semantic_ids` is `None` (synthetic-mode guard).
/// Also returns `Err` if `result.coords.len() != input.semantic_ids.len()` —
/// indicates a bug in the runner; we'd rather fail loudly than emit
/// misaligned edges.
pub fn build_layout_position_edges(
    input: &LayoutInput,
    result: &RunResult,
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

    let edges: Vec<WireEdge> = result
        .coords
        .iter()
        .enumerate()
        .map(|(i, c)| WireEdge {
            src: semantic_ids[i].clone(),
            dst: format!("HEX::{},{}", c.q, c.r),
            edge_type: LAYOUT_EDGE_TYPE.to_string(),
            metadata: Some(LAYOUT_METADATA_JSON.to_string()),
        })
        .collect();

    Ok(edges)
}

/// Write the layout result back to RFDB as `LAYOUT_POSITION` edges.
///
/// Builds the edges via [`build_layout_position_edges`] and submits them in
/// a single (or chunked, per `commit_batch`) request. Uses `defer_index =
/// true` to skip secondary index rebuilds; callers that need queryable
/// edges immediately should follow up with `rfdb.rebuild_indexes()`.
///
/// Returns the number of edges written. Errors are wrapped with context;
/// no panics in any error path.
///
/// Only meaningful when `LayoutInput` came from RFDB (`--socket` mode);
/// callers should branch on the `--commit` flag and only invoke this then.
pub async fn commit_layout(
    rfdb: &mut RfdbClient,
    input: &LayoutInput,
    result: &RunResult,
) -> Result<usize> {
    let edges = build_layout_position_edges(input, result)?;
    let n = edges.len();
    rfdb.commit_batch(&[], &[], &edges, true)
        .await
        .context("Failed to commit LAYOUT_POSITION edges")?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{generate, run_layout, LayoutStats, RunOpts};
    use crate::layout::HexCoord;
    use crate::layout::tree::FolderTree;
    use crate::layout::edges::Edge;

    /// Build a [`RunResult`] with the given coords and zero-stats — for tests
    /// that only care about the edge-construction logic.
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

    /// Build a minimal [`LayoutInput`] with `semantic_ids` populated.
    fn rfdb_style_input(ids: Vec<&str>) -> LayoutInput {
        let n = ids.len();
        LayoutInput {
            tree: FolderTree::build_from_paths(&[]),
            edges: Vec::<Edge>::new(),
            n_nodes: n,
            leaf_paths: ids.iter().map(|s| s.to_string()).collect(),
            semantic_ids: Some(ids.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn synthetic_input_returns_error() {
        // generate() always sets semantic_ids = None.
        let input = generate(10, 42, 1.0);
        let result = run_layout(&input, &RunOpts::default());

        let err = build_layout_position_edges(&input, &result).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("synthetic"),
            "error must mention synthetic mode, got: {msg}"
        );
    }

    #[test]
    fn rfdb_input_produces_one_edge_per_coord() {
        let input = rfdb_style_input(vec!["mod#a", "mod#b", "mod#c"]);
        let coords = vec![
            HexCoord { q: 0, r: 0 },
            HexCoord { q: 1, r: -1 },
            HexCoord { q: -2, r: 3 },
        ];
        let result = fake_result(coords);

        let edges = build_layout_position_edges(&input, &result).unwrap();
        assert_eq!(edges.len(), 3);

        // Edge shape: src = semantic id, dst = HEX::q,r, type, metadata.
        assert_eq!(edges[0].src, "mod#a");
        assert_eq!(edges[0].dst, "HEX::0,0");
        assert_eq!(edges[0].edge_type, "LAYOUT_POSITION");
        assert_eq!(
            edges[0].metadata.as_deref(),
            Some(r#"{"_source":"layout-pack"}"#)
        );

        assert_eq!(edges[1].src, "mod#b");
        assert_eq!(edges[1].dst, "HEX::1,-1");

        assert_eq!(edges[2].src, "mod#c");
        assert_eq!(edges[2].dst, "HEX::-2,3");
    }

    #[test]
    fn coord_count_mismatch_returns_error() {
        // Two semantic IDs but three coords → bug in runner; we should refuse.
        let input = rfdb_style_input(vec!["mod#a", "mod#b"]);
        let result = fake_result(vec![
            HexCoord { q: 0, r: 0 },
            HexCoord { q: 1, r: 0 },
            HexCoord { q: 2, r: 0 },
        ]);

        let err = build_layout_position_edges(&input, &result).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("misaligned"),
            "error must mention misalignment, got: {msg}"
        );
    }

    #[test]
    fn empty_rfdb_input_produces_zero_edges() {
        let input = rfdb_style_input(vec![]);
        let result = fake_result(vec![]);
        let edges = build_layout_position_edges(&input, &result).unwrap();
        assert!(edges.is_empty());
    }

    #[test]
    fn metadata_is_constant_across_edges() {
        let input = rfdb_style_input(vec!["mod#a", "mod#b"]);
        let result = fake_result(vec![
            HexCoord { q: 0, r: 0 },
            HexCoord { q: 1, r: 1 },
        ]);
        let edges = build_layout_position_edges(&input, &result).unwrap();
        // All edges share the same metadata string — caller can rely on this
        // for filtering by `_source`.
        assert_eq!(edges[0].metadata, edges[1].metadata);
    }

    #[test]
    fn negative_coords_serialised_correctly() {
        // Sanity-check signed-integer formatting in dst id.
        let input = rfdb_style_input(vec!["mod#x"]);
        let result = fake_result(vec![HexCoord { q: -42, r: -7 }]);
        let edges = build_layout_position_edges(&input, &result).unwrap();
        assert_eq!(edges[0].dst, "HEX::-42,-7");
    }
}
