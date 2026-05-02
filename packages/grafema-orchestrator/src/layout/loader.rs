//! RFDB-backed input loader for the per-symbol layout pipeline (DAI-22 Chunk-1).
//!
//! Queries every node type in [`PLACEABLE_TYPES`] plus every edge type in
//! [`LIFTABLE_EDGE_TYPES`] and folds them into a [`LayoutInput`] — the same
//! shape produced by [`super::synthetic::generate`], but with per-symbol
//! granularity (one tile per FUNCTION, METHOD, CLASS, etc.) rather than
//! MODULE-only.
//!
//! ## Pipeline
//!
//! 1. For each type in [`PLACEABLE_TYPES`] (in declaration order): stream
//!    `query_nodes_by_type`. Apply defensive filter:
//!    - drop if `file.is_empty()`,
//!    - drop if `file.ends_with('/')` (DIRECTORY sentinel),
//!    - drop if `id` starts with a [`VIRTUAL_SEMANTIC_ID_PREFIXES`] entry.
//! 2. Build parallel vectors keyed by NodeIdx (dense u32 over the placeable
//!    set): `leaf_paths`, `semantic_ids`, `rfdb_ids`, and the inverse
//!    `id_to_idx: FxHashMap<u128, NodeIdx>`. NodeIdx 0..=N-1 covers exactly
//!    the N placeable symbols — nothing else enters.
//! 3. For each type in [`LIFTABLE_EDGE_TYPES`]: datalog `edge(Src, Dst, "T")`.
//!    Resolve endpoints through `id_to_idx`; drop when either endpoint is not
//!    in the placeable set (this also drops inbound edges to VARIANT and
//!    other excluded types). Drop self-loops. Dedup by `(src, dst, type)`.
//! 4. Compute per-NodeIdx degree (incoming + outgoing) from the COLLECTED
//!    liftable edge set — no extra RFDB pass.
//! 5. Folder tree via [`FolderTree::build_from_paths_with_leaves`] so semantic
//!    IDs containing `/` survive intact (grafema V2 URI form).
//!
//! ## NodeIdx contract
//!
//! `NodeIdx` is a dense `u32` index into the placeable-symbol set only (~35k
//! for the current grafema graph), NOT the full RFDB node set (~328k). The
//! `rfdb_ids: Vec<u128>` side-map (on [`LayoutInput`]) is populated in lock-step
//! and consumed by the commit step (Chunk-2) to emit `LAYOUT_POSITION` edges
//! keyed by RFDB u128 id.
//!
//! ## Determinism
//!
//! Iteration order over PLACEABLE_TYPES is fixed (declaration order); within
//! each type we preserve RFDB's streaming order. `FolderTree` then re-sorts
//! intra-folder leaves by semantic-id lex for cross-DB stability.

use anyhow::{Context, Result};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::layout::synthetic::LayoutInput;
use crate::layout::{Edge, FolderTree, NodeIdx};
use crate::rfdb::{semantic_id_to_u128, DatalogResult, RfdbClient, WireNode};

/// Node types that are guaranteed to receive their own tile in the hex atlas.
/// Order is the deterministic iteration order; the loader walks this list in
/// sequence, so NodeIdx is assigned type-by-type.
///
/// VARIANT deliberately excluded in v1 (see `_tasks/DAI-22-.../004-plan-revised.md` §A.1):
/// enum-with-20-variants would cluster 21 tiles in a small region, hurting
/// readability. Trade-off: lose click-to-specific-variant navigability.
pub(crate) const PLACEABLE_TYPES: &[&str] = &[
    "MODULE",
    "FUNCTION",
    "METHOD",
    "CLASS",
    // VARIABLE / CONSTANT / INTERFACE removed Apr 2026 — together they
    // were 60% of the placed set and almost entirely local clutter. Keep
    // the orchestrator in sync with rfdb-server::layout_types so a stale
    // layout doesn't carry positions for nodes the server then drops.
    "TYPE_ALIAS",
    "TYPE_SYNONYM",
    "TYPE_CLASS",
    "DATA_TYPE",
    "ENUM",
    "STRUCT",
    "TRAIT",
    "IMPL_BLOCK",
    "INSTANCE",
    "NAMESPACE",
    "MACRO",
    "PROCESS",
    "MESSAGE_TYPE",
    "ASYNC_FUNCTION",
    "GLOBAL_DEFINITION",
    "EXTERNAL_FUNCTION",
    "EXTERNAL_MODULE",
    // Real design units that were missing — anonymous functions are
    // entry points for callbacks, constructors anchor object creation.
    "CLOSURE",
    "LAMBDA",
    "CONSTRUCTOR",
];

/// Edge types that contribute to the cohesion signal AND to per-symbol degree.
/// LAYOUT_POSITION is excluded to break the self-feedback loop; structural
/// edges (CONTAINS, DECLARES, HAS_*) are excluded because folder tree already
/// carries that containment; weak signals (RESOLVES_TO, REFERENCES) excluded
/// as noise. See §A.1 of the revised plan.
pub(crate) const LIFTABLE_EDGE_TYPES: &[&str] = &[
    "CALLS",
    "READS_FROM",
    "WRITES_TO",
    "IMPORTS_FROM",
    "DEPENDS_ON",
    "PASSES_ARGUMENT",
    "AWAITS",
    "RETURNS",
    "ITERATES_OVER",
    "HAS_METHOD",
    "ASSIGNED_FROM",
    "IMPLEMENTS",
    "EXTENDS",
    "INHERITS_FROM",
    "BROADCASTS_TO",
    "DISPATCHES_TO",
    "HANDLES_VARIANT",
    "THROWS",
    "CATCHES",
];

/// Semantic-id prefixes identifying virtual / resolver-synthesised nodes that
/// must NOT feed back into the layout packer. Each prefix corresponds to a
/// known synthetic node source: `HEX::` (prior layout output), `REGION::`
/// (prior region tree), `HASKELL_GLOBAL::` / `GLOBAL::` (unresolved-ref
/// virtuals emitted by HaskellLocalRefs / RuntimeGlobals resolvers).
pub(crate) const VIRTUAL_SEMANTIC_ID_PREFIXES: &[&str] = &[
    "HEX::",
    "REGION::",
    "HASKELL_GLOBAL::",
    "GLOBAL::",
];

/// Query the live RFDB and produce a per-symbol [`LayoutInput`] ready for `run_layout`.
pub async fn load_from_rfdb(rfdb: &mut RfdbClient) -> Result<LayoutInput> {
    // Collect placeable nodes type-by-type, preserving PLACEABLE_TYPES order.
    let mut nodes_by_type: Vec<(&'static str, Vec<WireNode>)> =
        Vec::with_capacity(PLACEABLE_TYPES.len());
    for ty in PLACEABLE_TYPES {
        let nodes = rfdb
            .query_nodes_by_type(ty)
            .await
            .with_context(|| format!("Failed to query {ty} nodes"))?;
        nodes_by_type.push((*ty, nodes));
    }

    // Collect liftable-edge pairs type-by-type.
    let mut edges_by_type: Vec<(&'static str, Vec<DatalogResult>)> =
        Vec::with_capacity(LIFTABLE_EDGE_TYPES.len());
    for ty in LIFTABLE_EDGE_TYPES {
        let query = format!(r#"lift(Src, Dst) :- edge(Src, Dst, "{ty}")."#);
        let rows = rfdb
            .datalog_query(&query)
            .await
            .with_context(|| format!("Failed to query {ty} edges"))?;
        edges_by_type.push((*ty, rows));
    }

    // Collect CONTAINS edges separately — they power src-side lift through
    // non-placeable intermediaries (CALL/REFERENCE/PROPERTY_ACCESS). Not part
    // of LIFTABLE_EDGE_TYPES (which is the cohesion signal set); CONTAINS is
    // pure structure.
    let contains_rows = rfdb
        .datalog_query(r#"contains(Src, Dst) :- edge(Src, Dst, "CONTAINS")."#)
        .await
        .with_context(|| "Failed to query CONTAINS edges")?;

    Ok(build_layout_input(
        &nodes_by_type,
        &edges_by_type,
        &contains_rows,
    ))
}

/// Pure transformation: `(placeable_nodes_by_type, liftable_edges_by_type)` → [`LayoutInput`].
///
/// Split out from [`load_from_rfdb`] so the post-query logic is unit-testable
/// without booting an RFDB server. Defensive filters (empty file, directory
/// sentinel, virtual prefix, unknown endpoint, self-loop) all live here.
pub(crate) fn build_layout_input(
    nodes_by_type: &[(&str, Vec<WireNode>)],
    edges_by_type: &[(&str, Vec<DatalogResult>)],
    contains_rows: &[DatalogResult],
) -> LayoutInput {
    let total_hint: usize = nodes_by_type.iter().map(|(_, v)| v.len()).sum();

    let mut leaf_paths: Vec<String> = Vec::with_capacity(total_hint);
    let mut semantic_ids: Vec<String> = Vec::with_capacity(total_hint);
    let mut rfdb_ids: Vec<u128> = Vec::with_capacity(total_hint);
    let mut id_to_idx: FxHashMap<u128, NodeIdx> = FxHashMap::default();
    id_to_idx.reserve(total_hint);

    for (ty, nodes) in nodes_by_type {
        for node in nodes {
            let Some(ref file) = node.file else {
                tracing::warn!(
                    node_id = %node.id,
                    node_type = ty,
                    "placeable node missing file field — skipping"
                );
                continue;
            };
            if file.is_empty() || file.ends_with('/') {
                tracing::debug!(
                    node_id = %node.id,
                    file = %file,
                    "skipping node with empty or directory-sentinel file path"
                );
                continue;
            }
            if VIRTUAL_SEMANTIC_ID_PREFIXES
                .iter()
                .any(|p| node.id.starts_with(p))
            {
                tracing::debug!(
                    node_id = %node.id,
                    "skipping node with virtual semantic-id prefix"
                );
                continue;
            }

            let u128_id = semantic_id_to_u128(&node.id);
            if let std::collections::hash_map::Entry::Vacant(e) = id_to_idx.entry(u128_id) {
                let idx = leaf_paths.len() as NodeIdx;
                e.insert(idx);
                leaf_paths.push(file.clone());
                semantic_ids.push(node.id.clone());
                rfdb_ids.push(u128_id);
            } else {
                tracing::warn!(
                    node_id = %node.id,
                    "duplicate RFDB id across placeable types — keeping first"
                );
            }
        }
    }

    let n_nodes = leaf_paths.len();

    // Build the folder tree using the opaque-leaf-id variant so semantic IDs
    // containing `/` (V2 URI form) survive without being interpreted as
    // folder separators.
    let triples: Vec<(NodeIdx, &str, &str)> = (0..n_nodes)
        .map(|i| (i as NodeIdx, leaf_paths[i].as_str(), semantic_ids[i].as_str()))
        .collect();
    let tree = FolderTree::build_from_paths_with_leaves(&triples);

    // Build CONTAINS parent index — maps a (potentially non-placeable) child's
    // RFDB u128 id to the NodeIdx of its placeable CONTAINS-parent. Enables
    // src-side lift for edges rooted at CALL / REFERENCE / PROPERTY_ACCESS
    // intermediaries whose true "owner" is the enclosing FUNCTION/METHOD/etc.
    // First write wins on collision (healthy DB has at most one CONTAINS parent
    // per child; duplicate is a data-quality issue we log once via counter).
    let mut parent_of: FxHashMap<u128, NodeIdx> = FxHashMap::default();
    parent_of.reserve(contains_rows.len());
    let mut parent_collisions: u64 = 0;
    for row in contains_rows {
        let Some(src_id) = binding_str(row, "Src") else { continue };
        let Some(dst_id) = binding_str(row, "Dst") else { continue };
        let src_u = semantic_id_to_u128(src_id);
        let dst_u = semantic_id_to_u128(dst_id);
        let Some(&parent_idx) = id_to_idx.get(&src_u) else { continue };
        match parent_of.entry(dst_u) {
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(parent_idx);
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                parent_collisions += 1;
            }
        }
    }

    // Resolve edges and collect them, dedup'd by (src, dst, type).
    // Src-side lift: if edge.src is not itself placeable but has a placeable
    // CONTAINS-parent, rewrite src → parent. Dst-side lift deferred (Chunk-12+).
    let mut edges: Vec<Edge> = Vec::new();
    let mut degree: Vec<u32> = vec![0; n_nodes];
    let mut seen: FxHashSet<(NodeIdx, NodeIdx, &str)> = FxHashSet::default();

    let mut direct_count: u64 = 0;
    let mut lifted_count: u64 = 0;
    let mut self_loop_after_lift: u64 = 0;
    let mut dropped_unreachable: u64 = 0;
    let mut per_type_direct: FxHashMap<&str, u64> = FxHashMap::default();
    let mut per_type_lifted: FxHashMap<&str, u64> = FxHashMap::default();

    for (ty, rows) in edges_by_type {
        for row in rows {
            let Some(src_id) = binding_str(row, "Src") else {
                tracing::warn!(
                    edge_type = ty,
                    bindings = ?row.bindings,
                    "edge row has no Src binding — skipping"
                );
                continue;
            };
            let Some(dst_id) = binding_str(row, "Dst") else {
                tracing::warn!(
                    edge_type = ty,
                    bindings = ?row.bindings,
                    "edge row has no Dst binding — skipping"
                );
                continue;
            };

            let src_u = semantic_id_to_u128(src_id);
            let dst_u = semantic_id_to_u128(dst_id);

            // Dst must be directly placeable (no dst-side lift in v1).
            let Some(&final_dst) = id_to_idx.get(&dst_u) else { continue };

            // Src: direct if placeable, else try CONTAINS-parent lift, else drop.
            let (final_src, was_lifted) = match id_to_idx.get(&src_u) {
                Some(&i) => (i, false),
                None => match parent_of.get(&src_u) {
                    Some(&p) => (p, true),
                    None => {
                        dropped_unreachable += 1;
                        continue;
                    }
                },
            };

            if final_src == final_dst {
                // Post-lift self-loop (e.g. A CONTAINS CALL, CALL CALLS A → A→A).
                self_loop_after_lift += 1;
                continue;
            }
            if !seen.insert((final_src, final_dst, *ty)) {
                continue;
            }

            degree[final_src as usize] = degree[final_src as usize].saturating_add(1);
            degree[final_dst as usize] = degree[final_dst as usize].saturating_add(1);

            edges.push(Edge {
                src: final_src,
                dst: final_dst,
                weight: 1.0,
            });

            if was_lifted {
                lifted_count += 1;
                *per_type_lifted.entry(*ty).or_insert(0) += 1;
            } else {
                direct_count += 1;
                *per_type_direct.entry(*ty).or_insert(0) += 1;
            }
        }
    }

    tracing::info!(
        total = direct_count + lifted_count,
        direct = direct_count,
        lifted = lifted_count,
        self_loop_after_lift,
        dropped_unreachable,
        parent_collisions,
        parent_index_size = parent_of.len(),
        "layout loader: collected {} edges ({} direct + {} lifted via CONTAINS-parent)",
        direct_count + lifted_count,
        direct_count,
        lifted_count,
    );

    // Per-edge-type split — useful under verbose logging to see which edge
    // types benefit from src-side lift (expect CALLS/READS_FROM/PASSES_ARGUMENT
    // dominant in lifted, HAS_METHOD/RETURNS dominant in direct).
    for (ty, _) in edges_by_type {
        let d = per_type_direct.get(ty).copied().unwrap_or(0);
        let l = per_type_lifted.get(ty).copied().unwrap_or(0);
        if d + l > 0 {
            tracing::debug!(
                edge_type = ty,
                direct = d,
                lifted = l,
                total = d + l,
                "layout loader per-type edge split"
            );
        }
    }

    LayoutInput {
        n_nodes,
        tree,
        edges,
        leaf_paths,
        semantic_ids: Some(semantic_ids),
        rfdb_ids: Some(rfdb_ids),
        degrees: Some(degree),
    }
}

/// Extract a string-typed binding from a Datalog result row.
fn binding_str<'a>(row: &'a DatalogResult, key: &str) -> Option<&'a str> {
    row.bindings.get(key).and_then(|v| v.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn node(ty: &str, id: &str, file: Option<&str>) -> WireNode {
        WireNode {
            id: id.to_string(),
            semantic_id: None,
            node_type: Some(ty.to_string()),
            name: None,
            file: file.map(|s| s.to_string()),
            exported: false,
            metadata: None,
        }
    }

    fn edge(src: &str, dst: &str) -> DatalogResult {
        let mut bindings = HashMap::new();
        bindings.insert("Src".to_string(), serde_json::Value::String(src.to_string()));
        bindings.insert("Dst".to_string(), serde_json::Value::String(dst.to_string()));
        DatalogResult { bindings }
    }

    #[test]
    fn empty_inputs_produce_empty_layout_input() {
        let input = build_layout_input(&[], &[], &[]);
        assert_eq!(input.n_nodes, 0);
        assert!(input.edges.is_empty());
        assert_eq!(input.rfdb_ids.as_ref().unwrap().len(), 0);
        assert_eq!(input.degrees.as_ref().unwrap().len(), 0);
    }

    #[test]
    fn loader_skips_directory_sentinel_file_paths() {
        // File path ending in '/' is a DIRECTORY sentinel (from http_server).
        // It must be dropped — never enter the placeable set.
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "a.rs->FUNCTION->foo", Some("a.rs")),
                node("FUNCTION", "pkg/->FUNCTION->dir", Some("pkg/")),
                node("FUNCTION", "empty", Some("")),
            ],
        )];
        let input = build_layout_input(&nodes, &[], &[]);
        assert_eq!(input.n_nodes, 1);
        assert_eq!(input.leaf_paths, vec!["a.rs"]);
    }

    #[test]
    fn loader_skips_virtual_semantic_id_prefixes() {
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "HEX::0,0", Some("a.rs")),
                node("FUNCTION", "REGION::1::pkg", Some("a.rs")),
                node("FUNCTION", "HASKELL_GLOBAL::putStrLn", Some("a.rs")),
                node("FUNCTION", "GLOBAL::console", Some("a.rs")),
                node("FUNCTION", "a.rs->FUNCTION->real", Some("a.rs")),
            ],
        )];
        let input = build_layout_input(&nodes, &[], &[]);
        assert_eq!(input.n_nodes, 1);
        assert_eq!(
            input.semantic_ids.as_ref().unwrap()[0],
            "a.rs->FUNCTION->real"
        );
    }

    #[test]
    fn loader_excludes_variant_from_placeable_set() {
        // Simulate loader: caller only queries PLACEABLE_TYPES, which does
        // NOT include VARIANT. We assert build_layout_input honours whatever
        // the caller passes — VARIANT not in input → not a leaf. Redundant
        // with "it's not in PLACEABLE_TYPES" but locks the invariant.
        assert!(!PLACEABLE_TYPES.contains(&"VARIANT"));
        // And build_layout_input doesn't silently add anything.
        let nodes = vec![(
            "FUNCTION",
            vec![node("FUNCTION", "a.rs->FUNCTION->foo", Some("a.rs"))],
        )];
        let input = build_layout_input(&nodes, &[], &[]);
        assert_eq!(input.n_nodes, 1);
    }

    #[test]
    fn loader_drops_edges_to_non_placeable_endpoints() {
        // FUNCTION a calls VARIANT b. Since VARIANT isn't passed in as
        // placeable, the edge endpoint won't resolve and the edge is dropped.
        let nodes = vec![(
            "FUNCTION",
            vec![node("FUNCTION", "a.rs->FUNCTION->a", Some("a.rs"))],
        )];
        let edges = vec![(
            "CALLS",
            vec![
                edge("a.rs->FUNCTION->a", "a.rs->VARIANT->Just"),
                edge("a.rs->FUNCTION->unknown", "a.rs->FUNCTION->a"),
            ],
        )];
        let input = build_layout_input(&nodes, &edges, &[]);
        assert!(input.edges.is_empty(), "edges to non-placeable dropped");
        // Degree on `a` stays 0 — no edge counted for it.
        assert_eq!(input.degrees.as_ref().unwrap()[0], 0);
    }

    #[test]
    fn loader_computes_degree_from_liftable_edges_only() {
        // 3 FUNCTIONs. a→b CALLS (in liftable), a→c contributes, b→c REFERENCES
        // (not in liftable — but since we only pass what the loader would pass,
        // here "liftable" means whatever keys are in edges_by_type). The
        // loader wouldn't pass REFERENCES rows at all. Assert degrees
        // accumulate only over what's passed.
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "f#a", Some("s.rs")),
                node("FUNCTION", "f#b", Some("s.rs")),
                node("FUNCTION", "f#c", Some("s.rs")),
            ],
        )];
        let edges = vec![
            ("CALLS", vec![edge("f#a", "f#b"), edge("f#a", "f#c")]),
            ("READS_FROM", vec![edge("f#b", "f#c")]),
        ];
        let input = build_layout_input(&nodes, &edges, &[]);
        let deg = input.degrees.as_ref().unwrap();
        // a: 2 out. b: 1 in + 1 out = 2. c: 2 in.
        assert_eq!(deg[0], 2);
        assert_eq!(deg[1], 2);
        assert_eq!(deg[2], 2);
        assert_eq!(input.edges.len(), 3);
    }

    #[test]
    fn loader_nodeidx_is_dense_over_placeable_set() {
        // 3 placeable + 1 skipped (virtual prefix) → NodeIdx range is 0..=2.
        let nodes = vec![
            (
                "FUNCTION",
                vec![
                    node("FUNCTION", "f#1", Some("a.rs")),
                    node("FUNCTION", "GLOBAL::skip", Some("a.rs")),
                ],
            ),
            ("CLASS", vec![node("CLASS", "c#1", Some("a.rs"))]),
            ("METHOD", vec![node("METHOD", "m#1", Some("a.rs"))]),
        ];
        let input = build_layout_input(&nodes, &[], &[]);
        assert_eq!(input.n_nodes, 3);
        assert_eq!(input.rfdb_ids.as_ref().unwrap().len(), 3);
        assert_eq!(input.semantic_ids.as_ref().unwrap().len(), 3);
        // rfdb_ids are all distinct
        let ids = input.rfdb_ids.as_ref().unwrap();
        assert_ne!(ids[0], ids[1]);
        assert_ne!(ids[1], ids[2]);
        assert_ne!(ids[0], ids[2]);
    }

    #[test]
    fn self_loop_edges_are_dropped() {
        let nodes = vec![(
            "FUNCTION",
            vec![node("FUNCTION", "f#a", Some("a.rs"))],
        )];
        let edges = vec![("CALLS", vec![edge("f#a", "f#a")])];
        let input = build_layout_input(&nodes, &edges, &[]);
        assert!(input.edges.is_empty());
        assert_eq!(input.degrees.as_ref().unwrap()[0], 0);
    }

    #[test]
    fn duplicate_edges_are_deduped() {
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "f#a", Some("a.rs")),
                node("FUNCTION", "f#b", Some("a.rs")),
            ],
        )];
        let edges = vec![(
            "CALLS",
            vec![edge("f#a", "f#b"), edge("f#a", "f#b")],
        )];
        let input = build_layout_input(&nodes, &edges, &[]);
        assert_eq!(input.edges.len(), 1);
        // Only one edge counted in degree.
        assert_eq!(input.degrees.as_ref().unwrap()[0], 1);
        assert_eq!(input.degrees.as_ref().unwrap()[1], 1);
    }

    #[test]
    fn same_src_dst_different_edge_types_both_kept() {
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "f#a", Some("a.rs")),
                node("FUNCTION", "f#b", Some("a.rs")),
            ],
        )];
        let edges = vec![
            ("CALLS", vec![edge("f#a", "f#b")]),
            ("READS_FROM", vec![edge("f#a", "f#b")]),
        ];
        let input = build_layout_input(&nodes, &edges, &[]);
        assert_eq!(input.edges.len(), 2);
    }

    // ---------- Chunk-12: src-side CONTAINS-parent lift ----------

    fn contains(src: &str, dst: &str) -> DatalogResult {
        // Same wire shape as a CALLS/READS_FROM datalog row, just semantically
        // reused as a CONTAINS row in the third build_layout_input argument.
        edge(src, dst)
    }

    #[test]
    fn lift_src_through_contains_promotes_call_to_parent_function() {
        // FUNCTION A in a.rs CONTAINS a CALL node. That CALL CALLS FUNCTION B.
        // Pre-Chunk-12: CALL is not in placeable set → edge dropped.
        // Chunk-12: src is lifted from CALL → FUNCTION A, so we get A→B.
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "a.rs->FUNCTION->A", Some("a.rs")),
                node("FUNCTION", "b.rs->FUNCTION->B", Some("b.rs")),
            ],
        )];
        // CALL node is NOT in the placeable set — that's the whole point.
        let edges = vec![(
            "CALLS",
            vec![edge("a.rs->CALL->B_at_5:12", "b.rs->FUNCTION->B")],
        )];
        let contains = vec![contains(
            "a.rs->FUNCTION->A",
            "a.rs->CALL->B_at_5:12",
        )];
        let input = build_layout_input(&nodes, &edges, &contains);
        assert_eq!(input.edges.len(), 1, "src-lift should rescue the edge");
        // NodeIdx 0 = A, 1 = B (declaration order in input).
        assert_eq!(input.edges[0].src, 0, "src lifted to FUNCTION A");
        assert_eq!(input.edges[0].dst, 1, "dst unchanged: FUNCTION B");
        // Degree accounting uses post-lift IDs.
        let deg = input.degrees.as_ref().unwrap();
        assert_eq!(deg[0], 1);
        assert_eq!(deg[1], 1);
    }

    #[test]
    fn lift_preserves_edge_type_through_rename() {
        // CALLS stays CALLS, READS_FROM stays READS_FROM — dedup key uses
        // edge type, so same (src, dst) across two types must yield two edges.
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "a.rs->FUNCTION->A", Some("a.rs")),
                node("FUNCTION", "b.rs->FUNCTION->B", Some("b.rs")),
            ],
        )];
        let edges = vec![
            ("CALLS", vec![edge("a.rs->CALL->x", "b.rs->FUNCTION->B")]),
            (
                "READS_FROM",
                vec![edge("a.rs->REFERENCE->x", "b.rs->FUNCTION->B")],
            ),
        ];
        let contains = vec![
            contains("a.rs->FUNCTION->A", "a.rs->CALL->x"),
            contains("a.rs->FUNCTION->A", "a.rs->REFERENCE->x"),
        ];
        let input = build_layout_input(&nodes, &edges, &contains);
        // Two edges A→B, one per type — not collapsed.
        assert_eq!(input.edges.len(), 2);
        // Both have same src/dst post-lift; types differ internally but Edge
        // struct doesn't carry type, so we just check the count + endpoints.
        for e in &input.edges {
            assert_eq!(e.src, 0);
            assert_eq!(e.dst, 1);
        }
    }

    #[test]
    fn lift_drops_self_loop_after_rename() {
        // FUNCTION A CONTAINS CALL c; CALL c CALLS FUNCTION A (recursion).
        // After lift: A→A → dropped as self-loop.
        let nodes = vec![(
            "FUNCTION",
            vec![node("FUNCTION", "a.rs->FUNCTION->A", Some("a.rs"))],
        )];
        let edges = vec![(
            "CALLS",
            vec![edge("a.rs->CALL->rec", "a.rs->FUNCTION->A")],
        )];
        let contains = vec![contains(
            "a.rs->FUNCTION->A",
            "a.rs->CALL->rec",
        )];
        let input = build_layout_input(&nodes, &edges, &contains);
        assert!(
            input.edges.is_empty(),
            "post-lift self-loop must be dropped"
        );
        assert_eq!(input.degrees.as_ref().unwrap()[0], 0);
    }

    #[test]
    fn lift_no_op_when_src_already_placeable() {
        // FUNCTION A directly CALLS FUNCTION B (no intermediary). Even with
        // a stray CONTAINS entry in the input, the src-lift path must NOT fire
        // because the direct path resolves first.
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "a.rs->FUNCTION->A", Some("a.rs")),
                node("FUNCTION", "b.rs->FUNCTION->B", Some("b.rs")),
            ],
        )];
        let edges = vec![(
            "CALLS",
            vec![edge("a.rs->FUNCTION->A", "b.rs->FUNCTION->B")],
        )];
        // Unrelated CONTAINS — proves it doesn't interfere.
        let contains = vec![contains(
            "a.rs->FUNCTION->A",
            "a.rs->CALL->irrelevant",
        )];
        let input = build_layout_input(&nodes, &edges, &contains);
        assert_eq!(input.edges.len(), 1);
        assert_eq!(input.edges[0].src, 0);
        assert_eq!(input.edges[0].dst, 1);
    }

    #[test]
    fn lift_no_op_when_src_has_no_placeable_parent() {
        // CALL with no CONTAINS parent in the index → edge dropped (pre-lift
        // behaviour preserved when lift can't apply).
        let nodes = vec![(
            "FUNCTION",
            vec![node("FUNCTION", "b.rs->FUNCTION->B", Some("b.rs"))],
        )];
        let edges = vec![(
            "CALLS",
            vec![edge("a.rs->CALL->orphan", "b.rs->FUNCTION->B")],
        )];
        // No CONTAINS edges at all.
        let input = build_layout_input(&nodes, &edges, &[]);
        assert!(input.edges.is_empty());
    }

    #[test]
    fn lift_deduplicates_two_calls_in_same_function_sharing_target() {
        // FUNCTION A contains two CALL nodes, both targeting FUNCTION B.
        // After src-lift both become A→B — dedup must collapse to one edge.
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "a.rs->FUNCTION->A", Some("a.rs")),
                node("FUNCTION", "b.rs->FUNCTION->B", Some("b.rs")),
            ],
        )];
        let edges = vec![(
            "CALLS",
            vec![
                edge("a.rs->CALL->B_at_5", "b.rs->FUNCTION->B"),
                edge("a.rs->CALL->B_at_9", "b.rs->FUNCTION->B"),
            ],
        )];
        let contains = vec![
            contains("a.rs->FUNCTION->A", "a.rs->CALL->B_at_5"),
            contains("a.rs->FUNCTION->A", "a.rs->CALL->B_at_9"),
        ];
        let input = build_layout_input(&nodes, &edges, &contains);
        assert_eq!(input.edges.len(), 1, "dedup collapses N CALLs → 1 A→B");
        assert_eq!(input.degrees.as_ref().unwrap()[0], 1);
        assert_eq!(input.degrees.as_ref().unwrap()[1], 1);
    }

    #[test]
    fn lift_determinism() {
        // Identical inputs must produce byte-identical outputs (edge order,
        // degree vector, node order). Runs the same fixture twice and asserts
        // field-by-field equality.
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "a.rs->FUNCTION->A", Some("a.rs")),
                node("FUNCTION", "b.rs->FUNCTION->B", Some("b.rs")),
                node("FUNCTION", "c.rs->FUNCTION->C", Some("c.rs")),
            ],
        )];
        let edges = vec![(
            "CALLS",
            vec![
                edge("a.rs->CALL->to_B", "b.rs->FUNCTION->B"),
                edge("a.rs->CALL->to_C", "c.rs->FUNCTION->C"),
            ],
        )];
        let contains = vec![
            contains("a.rs->FUNCTION->A", "a.rs->CALL->to_B"),
            contains("a.rs->FUNCTION->A", "a.rs->CALL->to_C"),
        ];

        let a = build_layout_input(&nodes, &edges, &contains);
        let b = build_layout_input(&nodes, &edges, &contains);

        assert_eq!(a.n_nodes, b.n_nodes);
        assert_eq!(a.leaf_paths, b.leaf_paths);
        assert_eq!(a.semantic_ids, b.semantic_ids);
        assert_eq!(a.rfdb_ids, b.rfdb_ids);
        assert_eq!(a.degrees, b.degrees);
        // Edge ordering must match exactly.
        assert_eq!(a.edges.len(), b.edges.len());
        for (ea, eb) in a.edges.iter().zip(b.edges.iter()) {
            assert_eq!(ea.src, eb.src);
            assert_eq!(ea.dst, eb.dst);
            assert_eq!(ea.weight, eb.weight);
        }
    }

    #[test]
    fn lift_counter_breakdown() {
        // Compose a fixture with 1 direct edge + 2 lifted edges + 1 dedup dup
        // of a lifted edge. Assert the edge count matches (3 direct + lifted,
        // 1 dropped as dedup). This indirectly exercises the counter logic
        // that feeds the tracing::info! line.
        let nodes = vec![(
            "FUNCTION",
            vec![
                node("FUNCTION", "a.rs->FUNCTION->A", Some("a.rs")),
                node("FUNCTION", "b.rs->FUNCTION->B", Some("b.rs")),
                node("FUNCTION", "c.rs->FUNCTION->C", Some("c.rs")),
            ],
        )];
        let edges = vec![(
            "CALLS",
            vec![
                // 1 direct: A → B
                edge("a.rs->FUNCTION->A", "b.rs->FUNCTION->B"),
                // 2 lifted via different CALLs, same target C → dedup to 1
                edge("a.rs->CALL->c1", "c.rs->FUNCTION->C"),
                edge("a.rs->CALL->c2", "c.rs->FUNCTION->C"),
            ],
        )];
        let contains = vec![
            contains("a.rs->FUNCTION->A", "a.rs->CALL->c1"),
            contains("a.rs->FUNCTION->A", "a.rs->CALL->c2"),
        ];
        let input = build_layout_input(&nodes, &edges, &contains);
        // 1 direct A→B kept + 1 lifted A→C kept (second lifted A→C deduped)
        assert_eq!(input.edges.len(), 2);
        let mut pairs: Vec<_> = input.edges.iter().map(|e| (e.src, e.dst)).collect();
        pairs.sort();
        assert_eq!(pairs, vec![(0, 1), (0, 2)]);
    }
}
