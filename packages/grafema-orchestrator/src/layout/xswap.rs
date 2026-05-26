//! Cross-folder boundary swap (`xswap`) — Rust port of
//! `sandbox/hex-sandbox/src/pack.js:798-947` (`xswapOptimise`).
//!
//! For every node, scan its 6 hex neighbours and consider exchanging coords
//! with any neighbour that belongs to a *different* leaf folder. A swap is
//! accepted iff:
//!
//! 1. The Σ link-length delta is strictly negative (incidence-only delta,
//!    same shape as `iswap::swap_delta`).
//! 2. After the swap, every ancestor folder of either node remains
//!    hex-connected. A swap that keeps the immediate folders intact may
//!    still tear an ancestor (e.g. swapping a `packages/util/src` cell with
//!    a `packages/parser/src` cell can fragment `packages/util`).
//!
//! The pass is single-shot — repeated passes give diminishing returns and
//! the connectivity BFS dominates cost. Returns the total accepted swap
//! count.
//!
//! ## Why both ancestor chains
//!
//! A swap exchanges coords but not folder membership: node `a` keeps its
//! `regionId`, just sits where `b` used to. So both `a`'s and `b`'s
//! transitive ancestor folders lose one member to the other folder's chain.
//! For the swap to be safe, every ancestor of either node must still be
//! hex-connected on its updated tile set.
//!
//! ## Determinism
//!
//! Same `(coords, state, tree, incidence)` input → byte-identical output.
//! Outer iteration is `0..n_nodes`. The 6-neighbour scan uses the fixed
//! `HEX_DIRS` order. The ancestor-chain dedup uses an `FxHashSet<FolderId>`
//! for O(1) membership but iteration order over that set affects only the
//! BFS *order*, not the boolean result of every-ancestor-connected — so the
//! decision is deterministic regardless.
//!
//! ## Performance
//!
//! For a node with degree `d` and average ancestor-chain length `D`, each
//! candidate costs `O(d)` for `swap_delta` plus `O(F · |F|)` per ancestor
//! `F` we BFS. The BFS only fires when `swap_delta < 0`, so most candidates
//! short-circuit on the cheap delta check.

use std::collections::VecDeque;

use rustc_hash::FxHashSet;

use super::edges::Incidence;
use super::hex::{pack_key, HexCoord, HEX_DIRS};
use super::state::{NodeIdx, PlacementState};
use super::tree::{FolderId, FolderTree};

/// Cross-folder boundary swap. For each node, scan its 6 hex neighbours
/// and consider swapping with any neighbour belonging to a different
/// folder. Accept iff `swap_delta < 0` AND every ancestor of either folder
/// remains hex-connected after the swap. Single pass.
///
/// Mutates `coords` and `state` in place; on rejection both are restored to
/// the pre-swap state (the rollback uses the same swap primitives, so the
/// `state.get(coords[i]) == i` invariant always holds at exit).
///
/// Returns total accepted swaps.
pub fn xswap(
    coords: &mut [HexCoord],
    state: &mut PlacementState,
    tree: &FolderTree,
    incidence: &Incidence,
) -> u32 {
    let n_nodes = coords.len();
    if n_nodes == 0 {
        return 0;
    }

    // ── Precompute: NodeIdx → leaf folder ─────────────────────────────────
    let node_to_folder = tree.node_to_folder(n_nodes);

    // ── Precompute: per-folder transitive node membership ────────────────
    // Mirrors pack.js:824-834. For every node, walk up its ancestor chain
    // and add it to each ancestor's transitive set. `transitive[fid]`
    // becomes the set of NodeIdx values whose folder is `fid` or a
    // descendant of `fid`. We use NodeIdx (not coords) so that membership
    // tracking is independent of coord changes during swap-and-revert.
    let n_folders = tree.len();
    let mut transitive: Vec<FxHashSet<NodeIdx>> = vec![FxHashSet::default(); n_folders];
    for (idx, fid) in node_to_folder.iter().enumerate() {
        if *fid == FolderId::MAX {
            continue;
        }
        let mut cursor: Option<FolderId> = Some(*fid);
        while let Some(id) = cursor {
            transitive[id as usize].insert(idx as NodeIdx);
            cursor = tree.get(id).parent;
        }
    }

    // ── Precompute: per-folder ancestor chain (incl. self, incl. root) ────
    // Mirrors pack.js:839-845. Cached because we look it up once per
    // candidate swap; rebuilding inside the loop would dominate.
    let mut ancestors: Vec<Vec<FolderId>> = vec![Vec::new(); n_folders];
    for (fid, _) in tree.iter() {
        let mut chain: Vec<FolderId> = Vec::new();
        let mut cursor: Option<FolderId> = Some(fid);
        while let Some(id) = cursor {
            chain.push(id);
            cursor = tree.get(id).parent;
        }
        ancestors[fid as usize] = chain;
    }

    // ── Single pass: scan boundaries ──────────────────────────────────────
    let mut total_swaps: u32 = 0;
    for n_idx in 0..n_nodes {
        let n_folder = node_to_folder[n_idx];
        if n_folder == FolderId::MAX {
            continue;
        }
        let coord_n = coords[n_idx];
        for d in HEX_DIRS.iter() {
            let nq = coord_n.q + d.q;
            let nr = coord_n.r + d.r;
            let neigh_idx = match state.get(nq, nr) {
                Some(idx) => idx as usize,
                None => continue, // empty cell — nothing to swap with
            };
            if neigh_idx == n_idx {
                continue; // shouldn't happen but defensive
            }
            let neigh_folder = node_to_folder[neigh_idx];
            if neigh_folder == FolderId::MAX || neigh_folder == n_folder {
                continue; // same folder → iswap territory; or unassigned
            }

            // Cheap delta check first — skip the expensive BFS if no win.
            let delta = swap_delta(n_idx as NodeIdx, neigh_idx as NodeIdx, coords, incidence);
            if delta >= -0.01 {
                continue;
            }

            // Tentatively swap coords + state. Snapshot in case we revert.
            let coord_a = coords[n_idx];
            let coord_b = coords[neigh_idx];
            state.swap(coord_a, coord_b);
            coords.swap(n_idx, neigh_idx);

            // Build the deduped ancestor chain to verify. Both n's and
            // neigh's ancestors must remain connected because both
            // transitive tile sets changed (each lost a member to the
            // other folder's chain). FxHashSet for O(1) dedup.
            let mut to_check: FxHashSet<FolderId> = FxHashSet::default();
            for fid in &ancestors[n_folder as usize] {
                to_check.insert(*fid);
            }
            for fid in &ancestors[neigh_folder as usize] {
                to_check.insert(*fid);
            }

            let ok = to_check
                .iter()
                .all(|fid| folder_connected(*fid, &transitive, coords));

            if ok {
                total_swaps += 1;
            } else {
                // Revert: same primitives, swap back. Snapshot variables
                // are now the post-swap coords for n_idx/neigh_idx, so
                // swap-back uses coord_b at n_idx and coord_a at neigh_idx.
                state.swap(coord_b, coord_a);
                coords.swap(n_idx, neigh_idx);
            }
        }
    }

    total_swaps
}

/// BFS the folder's transitive members on the hex grid, return `true` iff
/// every member is reachable from the seed. Mirrors `pack.js:875-899`.
///
/// `transitive[folder]` is the set of `NodeIdx` values belonging to the
/// folder transitively (precomputed once). We materialise the per-folder
/// `coord_set` from current `coords` because swaps mutate coords across
/// calls — the transitive node set is invariant under swap, but the cell
/// set is not.
///
/// Termination: visited count == coord_set size.
fn folder_connected(
    folder: FolderId,
    transitive: &[FxHashSet<NodeIdx>],
    coords: &[HexCoord],
) -> bool {
    let members = &transitive[folder as usize];
    if members.len() <= 1 {
        return true;
    }
    let mut coord_set: FxHashSet<i64> = FxHashSet::with_capacity_and_hasher(
        members.len(),
        Default::default(),
    );
    let mut seed: Option<HexCoord> = None;
    for &idx in members {
        let c = coords[idx as usize];
        coord_set.insert(pack_key(c.q, c.r));
        if seed.is_none() {
            seed = Some(c);
        }
    }
    let total = coord_set.len();
    let seed = seed.expect("folder with members must have a seed");

    let mut seen: FxHashSet<i64> = FxHashSet::with_capacity_and_hasher(total, Default::default());
    let mut queue: VecDeque<HexCoord> = VecDeque::new();
    seen.insert(pack_key(seed.q, seed.r));
    queue.push_back(seed);
    while let Some(cur) = queue.pop_front() {
        for d in HEX_DIRS.iter() {
            let nq = cur.q + d.q;
            let nr = cur.r + d.r;
            let key = pack_key(nq, nr);
            if coord_set.contains(&key) && !seen.contains(&key) {
                seen.insert(key);
                queue.push_back(HexCoord::new(nq, nr));
            }
        }
    }
    seen.len() == total
}

/// Compute Σ link-length delta if we were to swap `a` and `b`'s coords.
///
/// Mirrors `pack.js:852-873`, identical shape to `iswap::swap_delta` —
/// kept private to xswap.rs (rather than imported from iswap) because the
/// two modules are conceptually independent and this keeps each file
/// self-contained for review. Negative result = improvement.
fn swap_delta(
    a: NodeIdx,
    b: NodeIdx,
    coords: &[HexCoord],
    incidence: &Incidence,
) -> f32 {
    let coord_a = coords[a as usize];
    let coord_b = coords[b as usize];
    let mut delta: f32 = 0.0;

    // a's links — for each (other, w), other hasn't moved, but a will sit at b's coord.
    for &(other, w) in &incidence.by_node[a as usize] {
        if other == b {
            continue; // the a↔b link is symmetric; skip
        }
        let coord_other = coords[other as usize];
        let before = coord_a.distance(coord_other) as f32;
        let after = coord_b.distance(coord_other) as f32;
        delta += (after - before) * w;
    }

    // b's links — symmetric: b will sit at a's coord.
    for &(other, w) in &incidence.by_node[b as usize] {
        if other == a {
            continue;
        }
        let coord_other = coords[other as usize];
        let before = coord_b.distance(coord_other) as f32;
        let after = coord_a.distance(coord_other) as f32;
        delta += (after - before) * w;
    }

    delta
}

#[cfg(test)]
mod tests {
    use super::super::edges::{Edge, Incidence};
    use super::super::iswap::{iswap, total_link_length};
    use super::super::pack::pack;
    use super::super::tree::FolderTree;
    use super::super::validate::validate;
    use super::*;

    /// Build a deterministic-but-random-looking edge mix using an LCG.
    /// Used by the 50-leaf fixture; lifted out so the trial number can be
    /// tweaked without rewriting the loop.
    fn build_random_edges(n_nodes: usize, n_edges: usize, seed: u64) -> Vec<Edge> {
        let mut rng_state: u64 = seed;
        let mut next = || -> u32 {
            rng_state = rng_state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (rng_state >> 32) as u32
        };
        let mut edges: Vec<Edge> = Vec::new();
        for _ in 0..n_edges {
            let src = (next() as usize) % n_nodes;
            let dst = (next() as usize) % n_nodes;
            if src == dst {
                continue;
            }
            let w = 1.0 + ((next() as f32) / (u32::MAX as f32)) * 4.0;
            edges.push(Edge {
                src: src as NodeIdx,
                dst: dst as NodeIdx,
                weight: w,
            });
        }
        edges
    }

    #[test]
    fn no_edges_no_swap_accepted() {
        // 3 nodes in 3 folders, no edges. Boundaries exist but every
        // candidate has delta == 0 (>= 0), so xswap rejects all.
        let inputs = [(0u32, "a/x.rs"), (1u32, "b/y.rs"), (2u32, "c/z.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        let (mut coords, mut state) = pack(&tree, 3);
        let coords_before = coords.clone();
        let incidence = Incidence::build(3, &[]);

        let swaps = xswap(&mut coords, &mut state, &tree, &incidence);
        assert_eq!(swaps, 0, "no edges → no improvement → no swap");
        assert_eq!(coords, coords_before, "coords unchanged");

        // Spatial-index invariant.
        for (i, c) in coords.iter().enumerate() {
            assert_eq!(state.get(c.q, c.r), Some(i as NodeIdx));
        }
    }

    #[test]
    fn already_optimal_layout_no_swap() {
        // Hand-build a 4-node 2-folder layout where any boundary swap would
        // increase Σ link length: all intra-folder edges (each folder has
        // 2 nodes adjacent), no cross-folder edges. A boundary swap moves
        // a node away from its only edge target, so delta > 0.
        //
        // Folder "a": nodes 0, 1. Folder "b": nodes 2, 3.
        // After pack: 0,1 cluster; 2,3 cluster on the boundary.
        let inputs = [
            (0u32, "a/x.rs"),
            (1u32, "a/y.rs"),
            (2u32, "b/p.rs"),
            (3u32, "b/q.rs"),
        ];
        let tree = FolderTree::build_from_paths(&inputs);
        let (mut coords, mut state) = pack(&tree, 4);
        let coords_before = coords.clone();

        // Edges that pin each node to its same-folder partner only.
        let edges = [
            Edge { src: 0, dst: 1, weight: 10.0 },
            Edge { src: 2, dst: 3, weight: 10.0 },
        ];
        let incidence = Incidence::build(4, &edges);

        // First, run iswap to settle intra-folder layout.
        iswap(&mut coords, &mut state, &tree, &incidence);
        let coords_post_iswap = coords.clone();

        let swaps = xswap(&mut coords, &mut state, &tree, &incidence);
        assert_eq!(swaps, 0, "already-optimal layout: no improving cross-folder swap");
        assert_eq!(coords, coords_post_iswap, "coords unchanged after xswap");

        // Sanity: the no-edge folders fixture's coords must include some
        // boundary pair (otherwise this test trivially passes).
        let mut found_boundary = false;
        for i in 0..4 {
            for d in HEX_DIRS.iter() {
                if let Some(j) = state.get(coords[i].q + d.q, coords[i].r + d.r) {
                    let f_i = if i < 2 { "a" } else { "b" };
                    let j_idx = j as usize;
                    let f_j = if j_idx < 2 { "a" } else { "b" };
                    if f_i != f_j {
                        found_boundary = true;
                    }
                }
            }
        }
        assert!(found_boundary, "fixture has no cross-folder boundary — test would pass trivially");
        // also drop coords_before to silence unused-var warnings on certain builds
        let _ = coords_before;
    }

    #[test]
    fn one_profitable_swap_across_folder_boundary() {
        // Three folders A/B/C with a single node each. Edge (a, c) with
        // weight 10. After pack, a and b sit adjacent (boundary), c sits
        // somewhere on the perimeter. If swapping a↔b reduces dist(a,c),
        // xswap should accept.
        //
        // Determinism note: pack's exact coords depend on FolderTree
        // ordering (descending transitive_size, tiebreak by path). With
        // single-leaf folders all transitive_size == 1 → tiebreak by path
        // → A (id 1), B (id 2), C (id 3) packed in that order.
        let inputs = [(0u32, "a/x.rs"), (1u32, "b/y.rs"), (2u32, "c/z.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        let (mut coords, mut state) = pack(&tree, 3);

        let edges = [Edge { src: 0, dst: 2, weight: 10.0 }];
        let incidence = Incidence::build(3, &edges);

        let len_before = total_link_length(&coords, &edges);
        let swaps = xswap(&mut coords, &mut state, &tree, &incidence);
        let len_after = total_link_length(&coords, &edges);

        // The setup should produce exactly one improving swap (a↔b).
        // If pack happens to place 'a' already adjacent to 'c', no swap.
        // Verify: either we swapped and len strictly decreased, or no swap
        // was needed (len already minimal — a is already adjacent to c).
        if len_before > len_after {
            assert_eq!(swaps, 1, "expected exactly one improving swap");
            assert!(
                len_after < len_before,
                "Σ link should strictly decrease: {} → {}",
                len_before,
                len_after
            );
        } else {
            // a was already adjacent to c → no swap profitable.
            assert_eq!(swaps, 0);
            assert_eq!(len_after, len_before);
        }

        // Spatial-index invariant.
        for (i, c) in coords.iter().enumerate() {
            assert_eq!(state.get(c.q, c.r), Some(i as NodeIdx));
        }

        // Connectivity preserved.
        let report = validate(&coords, &tree);
        assert!(report.torn.is_empty(), "xswap broke connectivity: {:?}", report.torn);
    }

    #[test]
    fn fifty_leaves_pack_iswap_xswap_strictly_improves() {
        // 50-leaf 5-folder synthetic with random cross-folder edges.
        // Run pack → iswap → xswap. Verify strict improvement at each step
        // and that connectivity is preserved.
        let n_nodes = 50usize;
        let leaves: Vec<(NodeIdx, String)> = (0..n_nodes)
            .map(|i| {
                let folder = [
                    "packages/a",
                    "packages/b",
                    "packages/c/sub",
                    "packages/c/sub2",
                    "packages/d",
                ][i / 10];
                (i as u32, format!("{}/file{}.rs", folder, i))
            })
            .collect();
        let pairs: Vec<(NodeIdx, &str)> =
            leaves.iter().map(|(i, s)| (*i, s.as_str())).collect();
        let tree = FolderTree::build_from_paths(&pairs);

        let edges = build_random_edges(n_nodes, 80, 0x9E37_79B9_7F4A_7C15);
        assert!(edges.len() >= 60);
        let incidence = Incidence::build(n_nodes, &edges);

        // Stage 1: pack only.
        let (mut coords1, _state1) = pack(&tree, n_nodes);
        let len_pack = total_link_length(&coords1, &edges);

        // Stage 2: pack + iswap.
        let (mut coords2, mut state2) = pack(&tree, n_nodes);
        iswap(&mut coords2, &mut state2, &tree, &incidence);
        let len_iswap = total_link_length(&coords2, &edges);

        // Stage 3: pack + iswap + xswap.
        let (mut coords3, mut state3) = pack(&tree, n_nodes);
        iswap(&mut coords3, &mut state3, &tree, &incidence);
        let xswaps = xswap(&mut coords3, &mut state3, &tree, &incidence);
        let len_xswap = total_link_length(&coords3, &edges);

        // Σ link length monotonically decreases.
        assert!(
            len_iswap <= len_pack,
            "iswap regressed: pack={} iswap={}",
            len_pack,
            len_iswap
        );
        assert!(
            len_xswap < len_pack,
            "xswap+iswap not strictly better than pack: pack={} xswap={}",
            len_pack,
            len_xswap
        );
        assert!(
            len_xswap <= len_iswap,
            "xswap regressed iswap: iswap={} xswap={}",
            len_iswap,
            len_xswap
        );
        assert!(xswaps > 0, "expected at least one cross-folder improving swap");

        // Print for the report (visible with `cargo test -- --nocapture`).
        let pct_iswap = (1.0 - len_iswap / len_pack) * 100.0;
        let pct_xswap = (1.0 - len_xswap / len_pack) * 100.0;
        eprintln!(
            "[xswap fixture] pack={:.2}  iswap={:.2} ({:+.1}%)  +xswap={:.2} ({:+.1}%)  swaps={}",
            len_pack, len_iswap, -pct_iswap, len_xswap, -pct_xswap, xswaps
        );

        // Connectivity preserved.
        let report = validate(&coords3, &tree);
        assert!(
            report.torn.is_empty(),
            "xswap introduced torn folders: {:?}",
            report.torn.iter().map(|t| t.path.clone()).collect::<Vec<_>>()
        );

        // Spatial-index invariant.
        for (i, c) in coords3.iter().enumerate() {
            assert_eq!(state3.get(c.q, c.r), Some(i as NodeIdx),
                "spatial index drift at node {}", i);
        }
    }

    #[test]
    fn connectivity_preserved_when_swap_would_tear_folder() {
        // Adversarial fixture: a swap that would reduce Σ link length but
        // would also tear an ancestor folder. xswap must reject it.
        //
        // Geometry (axial coords, hand-placed; bypasses pack):
        //
        //    p0 (0,0) — p1 (1,0) — p2 (2,0)         the chain
        //                  |
        //                 q0 (1,-1)                 boundary partner north of p1
        //
        // Folder "p" tile set: {(0,0), (1,0), (2,0)} — hex-connected.
        // Folder "q" tile set: {(1,-1)}.
        //
        // Candidate swap: p1 ↔ q0 (boundary, different folders, adjacent).
        // After swap:
        //   p0 at (0,0), p1 at (1,-1), p2 at (2,0), q0 at (1,0).
        //   New p tile set: {(0,0), (1,-1), (2,0)}.
        //     dist((0,0),(1,-1)) = 1 ✓ adjacent
        //     dist((1,-1),(2,0)) = max(1,1,2) = 2 ✗ NOT adjacent
        //     dist((0,0),(2,0))  = 2 ✗ NOT adjacent
        //   → p is torn (BFS from (0,0) reaches {(0,0),(1,-1)} but not (2,0)).
        //
        // Edge to make the swap profitable: (q0, p2) weight 100.
        //   dist((1,-1),(2,0)) = 2 before; after q0 sits at (1,0):
        //   dist((1,0),(2,0)) = 1 → Δ = (1 - 2) * 100 = -100. Profitable.
        // p1 has no edges, so swap_delta(1, 3) only sees q0's incidence.
        //
        // Expected: xswap WANTS to accept (Δ = -100) but the ancestor BFS
        // on "p" rejects it. swaps == 0, coords unchanged, validate clean.

        let inputs = [
            (0u32, "p/p0.rs"),
            (1u32, "p/p1.rs"),
            (2u32, "p/p2.rs"),
            (3u32, "q/q0.rs"),
        ];
        let tree = FolderTree::build_from_paths(&inputs);

        // Hand-place coords to set up the adversarial geometry. Bypassing
        // pack here is intentional: pack would not naturally produce this
        // adversarial layout.
        let coords_init = vec![
            HexCoord::new(0, 0),   // p0
            HexCoord::new(1, 0),   // p1 — the bridge
            HexCoord::new(2, 0),   // p2 — chain end
            HexCoord::new(1, -1),  // q0 — boundary partner
        ];
        let mut state = PlacementState::new();
        for (i, c) in coords_init.iter().enumerate() {
            state.place(i as NodeIdx, *c).unwrap();
        }
        let mut coords = coords_init.clone();

        // Initial state: p tile set is hex-connected → no torn folders.
        let report_before = validate(&coords, &tree);
        assert!(
            report_before.torn.is_empty(),
            "fixture should start with no torn folders, got {:?}",
            report_before.torn
        );

        // Edge (q0, p2) weight 100. After swap p1↔q0, q0 sits at (1,0)
        // adjacent to p2 at (2,0) → distance drops 2 → 1 → Δ = -100.
        let edges = [Edge { src: 3, dst: 2, weight: 100.0 }];
        let incidence = Incidence::build(4, &edges);

        // Confirm the candidate swap p1↔q0 IS profitable by Σ delta.
        let raw_delta = swap_delta(1, 3, &coords, &incidence);
        assert!(
            raw_delta < 0.0,
            "test setup invalid: swap delta should be negative but got {}",
            raw_delta
        );

        let len_before = total_link_length(&coords, &edges);
        let swaps = xswap(&mut coords, &mut state, &tree, &incidence);
        let len_after = total_link_length(&coords, &edges);

        assert_eq!(
            swaps, 0,
            "xswap accepted a connectivity-breaking swap (Σ went {} → {})",
            len_before, len_after
        );
        // Coords must be unchanged (rollback worked).
        assert_eq!(coords, coords_init, "coords mutated despite no accepted swap");

        // Validate again — still no torn folders.
        let report_after = validate(&coords, &tree);
        assert!(
            report_after.torn.is_empty(),
            "xswap rollback failed to restore connectivity: {:?}",
            report_after.torn
        );

        // Spatial-index invariant.
        for (i, c) in coords.iter().enumerate() {
            assert_eq!(state.get(c.q, c.r), Some(i as NodeIdx),
                "spatial index drift at node {} after rejected swap", i);
        }
    }

    #[test]
    fn xswap_is_deterministic_across_runs() {
        // Same input twice → same output.
        let n_nodes = 30usize;
        let leaves: Vec<(NodeIdx, String)> = (0..n_nodes)
            .map(|i| {
                let folder = [
                    "packages/a",
                    "packages/b",
                    "packages/c/sub",
                ][i / 10];
                (i as u32, format!("{}/file{}.rs", folder, i))
            })
            .collect();
        let pairs: Vec<(NodeIdx, &str)> =
            leaves.iter().map(|(i, s)| (*i, s.as_str())).collect();
        let tree = FolderTree::build_from_paths(&pairs);

        let edges = build_random_edges(n_nodes, 50, 0xCAFE_BABE_DEAD_BEEF);
        let inc = Incidence::build(n_nodes, &edges);

        let (mut c1, mut st1) = pack(&tree, n_nodes);
        iswap(&mut c1, &mut st1, &tree, &inc);
        let s1 = xswap(&mut c1, &mut st1, &tree, &inc);

        let (mut c2, mut st2) = pack(&tree, n_nodes);
        iswap(&mut c2, &mut st2, &tree, &inc);
        let s2 = xswap(&mut c2, &mut st2, &tree, &inc);

        assert_eq!(s1, s2, "xswap swap count is non-deterministic");
        assert_eq!(c1, c2, "xswap output coords are non-deterministic");
    }
}
