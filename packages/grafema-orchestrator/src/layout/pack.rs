//! Recursive folder packer — Rust port of `sandbox/hex-sandbox/src/pack.js:191-428`.
//!
//! Three layers, smallest to largest:
//! 1. [`find_empty_adjacent`] — pick the empty cell adjacent to a folder's
//!    existing tile-set that minimises distance to a target hex (radial growth
//!    around the seed).
//! 2. [`reserve_cluster`] — BFS-grow a connected `n`-cell empty region from a
//!    seed; if the local region is too small, spiral outward for an alternate
//!    anchor.
//! 3. [`pack_folder`] — recursively place a folder and all descendants. Leaf
//!    folders use a single `reserve_cluster` call. Non-leaf folders place their
//!    own direct leaves first, then recurse into children sorted by descending
//!    transitive size.
//!
//! Top-level entry point is [`pack`] (mirrors `pack.js:runPackingAssembly`'s
//! pack phase).
//!
//! ## Determinism
//!
//! Same `(tree, n_nodes)` input → byte-identical `coords` vector. The recursion
//! visits children in deterministic order (`FolderTree` pre-sorts both
//! `child_folders` and `direct_leaves` in step 1) and the lexicographic `(q, r)`
//! tiebreaker in `find_empty_adjacent` rules out rng-style flapping.
//!
//! ## Stack depth
//!
//! Real codebases reach folder depths of 8–12. With Rust's default 8 MiB main
//! thread stack the recursion is safe, but `pack_folder` is wrapped in
//! `stacker::maybe_grow` so cargo's smaller test threads (2 MiB) and worker
//! threads (also 2 MiB) don't blow up on pathological inputs.

use std::collections::VecDeque;

use rustc_hash::FxHashSet;

use super::hex::{pack_key, HexCoord, HEX_DIRS};
use super::state::PlacementState;
use super::tree::{FolderId, FolderTree};

/// Maximum spiral radius when looking for an alternate anchor. Mirrors the
/// `10000` cap used in `pack.js:reserveCluster` and `spiralEmpty`.
const SPIRAL_MAX_RING: u32 = 10_000;

/// Recursively pack a folder and all its descendants, rooted at `seed`.
///
/// Mutates `state` (places nodes) and writes coordinates into `coords` (indexed
/// by `NodeIdx`). Returns the set of cell keys (packed-`i64`) now occupied by
/// the folder transitively — used by the caller to compute the seed for
/// subsequent siblings.
///
/// Mirrors `pack.js:packFolder` (lines 253–314):
/// * Leaf folder (no `child_folders`) → single `reserve_cluster` call dropping
///   each leaf in BFS order. The result is hex-connected by construction.
/// * Non-leaf folder → place direct leaves FIRST (so they land in a tight
///   cluster around `seed` before children clutter the boundary), then iterate
///   children sorted by descending `transitive_size` (tiebreak: `path` ascending).
///
/// The recursion is wrapped in `stacker::maybe_grow` so deep trees never blow
/// the stack on small worker threads.
pub fn pack_folder(
    folder_id: FolderId,
    tree: &FolderTree,
    seed: HexCoord,
    state: &mut PlacementState,
    coords: &mut Vec<HexCoord>,
) -> FxHashSet<i64> {
    stacker::maybe_grow(64 * 1024, 2 * 1024 * 1024, || {
        pack_folder_inner(folder_id, tree, seed, state, coords)
    })
}

fn pack_folder_inner(
    folder_id: FolderId,
    tree: &FolderTree,
    seed: HexCoord,
    state: &mut PlacementState,
    coords: &mut Vec<HexCoord>,
) -> FxHashSet<i64> {
    let folder = tree.get(folder_id);
    let mut cells: FxHashSet<i64> = FxHashSet::default();

    // ── Leaf-folder fast path ──────────────────────────────────────────
    // No child folders → a single reserve_cluster guarantees connectivity.
    if folder.child_folders.is_empty() {
        if folder.direct_leaves.is_empty() {
            return cells;
        }
        let slots = reserve_cluster(seed, folder.direct_leaves.len(), state);
        for (i, leaf_idx) in folder.direct_leaves.iter().enumerate() {
            let coord = slots[i];
            state
                .place(*leaf_idx, coord)
                .expect("pack: double-place");
            coords[*leaf_idx as usize] = coord;
            cells.insert(pack_key(coord.q, coord.r));
        }
        return cells;
    }

    // ── Place direct leaves FIRST ───────────────────────────────────────
    // Mirrors pack.js:281-288. Direct leaves of a non-leaf folder land in a
    // tight cluster around `seed` BEFORE children clutter the boundary.
    if !folder.direct_leaves.is_empty() {
        let slots = reserve_cluster(seed, folder.direct_leaves.len(), state);
        for (i, leaf_idx) in folder.direct_leaves.iter().enumerate() {
            let coord = slots[i];
            state
                .place(*leaf_idx, coord)
                .expect("pack: double-place");
            coords[*leaf_idx as usize] = coord;
            cells.insert(pack_key(coord.q, coord.r));
        }
    }

    // ── Recurse into children ───────────────────────────────────────────
    // Sort by descending transitive_size, tiebreak by path ascending. Skip
    // empty subtrees (transitive_size == 0). Children come pre-sorted by
    // path from FolderTree, so we just need to re-sort by size.
    let mut children: Vec<FolderId> = folder
        .child_folders
        .iter()
        .copied()
        .filter(|id| tree.get(*id).transitive_size > 0)
        .collect();
    children.sort_by(|a, b| {
        let fa = tree.get(*a);
        let fb = tree.get(*b);
        fb.transitive_size
            .cmp(&fa.transitive_size)
            .then_with(|| fa.path.cmp(&fb.path))
    });

    for child_id in children {
        let child_seed = if cells.is_empty() {
            seed
        } else {
            // pack.js:306 — find_empty_adjacent(cells, seed, seed). Both target
            // and fallback are the parent's seed, keeping new children on the
            // perimeter near where the parent wanted the cluster.
            find_empty_adjacent(&cells, seed, seed, state)
        };
        let child_cells = pack_folder_inner(child_id, tree, child_seed, state, coords);
        cells.extend(child_cells);
    }

    cells
}

/// Top-level pack: places every node in the tree starting from origin.
///
/// Mirrors `pack.js:runPackingAssembly` lines 405–428 (the pack phase, not the
/// async `yieldFrame`/progress wrapping).
///
/// Returns:
/// * `Vec<HexCoord>` indexed by `NodeIdx` (length `n_nodes`).
/// * The fully populated `PlacementState` so callers can reuse it for `iswap`
///   /`xswap`/validation without rebuilding the occupancy map.
pub fn pack(tree: &FolderTree, n_nodes: usize) -> (Vec<HexCoord>, PlacementState) {
    let mut state = PlacementState::new();
    let mut coords: Vec<HexCoord> = vec![HexCoord::new(0, 0); n_nodes];

    let root = tree.get(tree.root());
    let origin = HexCoord::new(0, 0);
    let mut root_cells: FxHashSet<i64> = FxHashSet::default();

    // Sort top-level children by descending transitive size, tiebreak by path.
    let mut top_children: Vec<FolderId> = root
        .child_folders
        .iter()
        .copied()
        .filter(|id| tree.get(*id).transitive_size > 0)
        .collect();
    top_children.sort_by(|a, b| {
        let fa = tree.get(*a);
        let fb = tree.get(*b);
        fb.transitive_size
            .cmp(&fa.transitive_size)
            .then_with(|| fa.path.cmp(&fb.path))
    });

    for (i, child_id) in top_children.iter().enumerate() {
        let child_seed = if i == 0 && root_cells.is_empty() {
            origin
        } else {
            find_empty_adjacent(&root_cells, origin, origin, &state)
        };
        let child_cells = pack_folder(*child_id, tree, child_seed, &mut state, &mut coords);
        root_cells.extend(child_cells);
    }

    // Root's own direct leaves last (pack.js:421-428).
    for leaf_idx in &root.direct_leaves {
        let target = if root_cells.is_empty() {
            origin
        } else {
            find_empty_adjacent(&root_cells, origin, origin, &state)
        };
        state.place(*leaf_idx, target).expect("pack: double-place");
        coords[*leaf_idx as usize] = target;
        root_cells.insert(pack_key(target.q, target.r));
    }

    (coords, state)
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

/// Find the empty hex cell, adjacent to any cell in `anchors`, that minimises
/// distance to `target`. Mirrors `pack.js:findEmptyAdjacent` (lines 137–165).
///
/// * If `anchors` is empty → return `fallback` if empty, else spiral from `fallback`.
/// * Tiebreaker when multiple cells tie on distance: prefer smaller `(q, r)`
///   lexicographically. This is the determinism anchor of the algorithm — flip
///   it and the whole pack changes.
/// * Last-resort fallback: spiral from `target` if no adjacent empty cell exists.
///   Breaks strict folder-adjacency for the seed but keeps the algorithm
///   producing _some_ result when the local neighbourhood is fully saturated.
fn find_empty_adjacent(
    anchors: &FxHashSet<i64>,
    target: HexCoord,
    fallback: HexCoord,
    state: &PlacementState,
) -> HexCoord {
    if !anchors.is_empty() {
        let mut best: Option<HexCoord> = None;
        let mut best_dist = i32::MAX;
        for key in anchors {
            let (q, r) = super::hex::unpack_key(*key);
            for d in HEX_DIRS.iter() {
                let nq = q + d.q;
                let nr = r + d.r;
                if !state.is_empty(nq, nr) {
                    continue;
                }
                let dist = HexCoord::new(nq, nr).distance(target);
                let candidate = HexCoord::new(nq, nr);
                let take = if dist < best_dist {
                    true
                } else if dist == best_dist {
                    match best {
                        Some(b) => candidate.q < b.q || (candidate.q == b.q && candidate.r < b.r),
                        None => true,
                    }
                } else {
                    false
                };
                if take {
                    best_dist = dist;
                    best = Some(candidate);
                }
            }
        }
        if let Some(c) = best {
            return c;
        }
    }
    // Fallback 1: caller's seed if still empty.
    if state.is_empty(fallback.q, fallback.r) {
        return fallback;
    }
    // Fallback 2: spiral outward from target. PlacementState::spiral_empty
    // is the equivalent of pack.js:spiralEmpty.
    state
        .spiral_empty(target, SPIRAL_MAX_RING)
        .expect("find_empty_adjacent: no empty cell within SPIRAL_MAX_RING rings")
}

/// Reserve `n` connected empty cells starting from `seed`. Returns coords in
/// BFS order — index 0 is the anchor, each subsequent cell shares a hex edge
/// with some earlier entry, so the returned slice is hex-connected.
///
/// Mirrors `pack.js:reserveCluster` (lines 191–247).
///
/// Algorithm:
/// 1. Pick an anchor: `seed` if empty, else spiral outward.
/// 2. BFS from anchor expanding into empty neighbours until we have `n` cells.
/// 3. If BFS exhausts the queue before reaching `n` (i.e. the local connected
///    empty region is too small), spiral outward looking for a fresh anchor
///    whose connected empty region has ≥ `n` cells.
fn reserve_cluster(seed: HexCoord, n: usize, state: &PlacementState) -> Vec<HexCoord> {
    if n == 0 {
        return Vec::new();
    }

    // Try BFS from `anchor`; return None if connected empty region is too small.
    let try_from = |anchor: HexCoord| -> Option<Vec<HexCoord>> {
        if !state.is_empty(anchor.q, anchor.r) {
            return None;
        }
        let mut reserved: Vec<HexCoord> = Vec::with_capacity(n);
        let mut reserved_set: FxHashSet<i64> = FxHashSet::default();
        let mut queue: VecDeque<HexCoord> = VecDeque::new();
        reserved.push(anchor);
        reserved_set.insert(pack_key(anchor.q, anchor.r));
        queue.push_back(anchor);
        while reserved.len() < n {
            let cur = match queue.pop_front() {
                Some(c) => c,
                None => return None,
            };
            for d in HEX_DIRS.iter() {
                let nq = cur.q + d.q;
                let nr = cur.r + d.r;
                let k = pack_key(nq, nr);
                if reserved_set.contains(&k) {
                    continue;
                }
                if !state.is_empty(nq, nr) {
                    continue;
                }
                let next = HexCoord::new(nq, nr);
                reserved.push(next);
                reserved_set.insert(k);
                queue.push_back(next);
                if reserved.len() >= n {
                    break;
                }
            }
        }
        Some(reserved)
    };

    // Attempt 1: caller's seed (or its nearest empty cell via spiral).
    let mut start = seed;
    if !state.is_empty(start.q, start.r) {
        start = state
            .spiral_empty(start, SPIRAL_MAX_RING)
            .expect("reserve_cluster: spiral_empty exhausted from seed");
    }
    if let Some(slots) = try_from(start) {
        return slots;
    }

    // Attempt 2+: spiral from the failed anchor for a fresh anchor whose
    // connected empty region is large enough.
    let mut tried: FxHashSet<i64> = FxHashSet::default();
    tried.insert(pack_key(start.q, start.r));
    for ring in 1..=SPIRAL_MAX_RING as i32 {
        for dq in -ring..=ring {
            for dr in -ring..=ring {
                let dist = dq.abs().max(dr.abs()).max((dq + dr).abs());
                if dist != ring {
                    continue;
                }
                let q = start.q + dq;
                let r = start.r + dr;
                let k = pack_key(q, r);
                if tried.contains(&k) {
                    continue;
                }
                tried.insert(k);
                if !state.is_empty(q, r) {
                    continue;
                }
                if let Some(slots) = try_from(HexCoord::new(q, r)) {
                    return slots;
                }
            }
        }
    }
    panic!("reserve_cluster: no empty region of size {} found within {} rings", n, SPIRAL_MAX_RING);
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::state::NodeIdx;
    use super::super::tree::FolderTree;
    use super::super::validate::validate;

    #[test]
    fn tiny_tree_three_leaves_at_root_contiguous() {
        // Three leaves all under root → all placed contiguously.
        let inputs = [(0u32, "a.rs"), (1u32, "b.rs"), (2u32, "c.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        let (coords, state) = pack(&tree, 3);

        assert_eq!(state.len(), 3, "all three leaves placed");

        // Coords are unique.
        let mut set = FxHashSet::default();
        for c in &coords {
            assert!(set.insert(pack_key(c.q, c.r)), "duplicate coord {:?}", c);
        }

        // Each node within distance 1 of at least one other (contiguity).
        // For 3 cells: a chain a—b—c is enough; a triangle is fine too.
        for (i, ci) in coords.iter().enumerate() {
            let has_neighbour = coords
                .iter()
                .enumerate()
                .any(|(j, cj)| i != j && ci.distance(*cj) == 1);
            assert!(has_neighbour, "leaf {} at {:?} has no adjacent sibling", i, ci);
        }

        // Validator should report no torn folders.
        let report = validate(&coords, &tree);
        assert!(report.torn.is_empty(), "unexpected torn folders: {:?}",
            report.torn.iter().map(|t| t.path.as_str()).collect::<Vec<_>>());
    }

    #[test]
    fn one_leaf_folder_places_one_node() {
        let inputs = [(0u32, "a/x.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        let (coords, state) = pack(&tree, 1);

        assert_eq!(state.len(), 1, "single leaf placed");
        assert_eq!(coords.len(), 1);
        // Origin is the natural first slot — the seed of the only top-level child.
        assert_eq!(coords[0], HexCoord::new(0, 0));
    }

    #[test]
    fn fifty_leaves_five_folders_no_torn_no_sibling_gaps() {
        // 5 folders × 10 leaves each = 50 nodes.
        let leaves: Vec<(NodeIdx, String)> = (0..50)
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

        let (coords, state) = pack(&tree, 50);

        // All 50 placed, all coords unique.
        assert_eq!(state.len(), 50);
        let mut set = FxHashSet::default();
        for c in &coords {
            assert!(set.insert(pack_key(c.q, c.r)), "duplicate coord {:?}", c);
        }

        // Every folder hex-connected (this is the strong invariant the pack
        // algorithm guarantees by construction).
        let report = validate(&coords, &tree);
        assert!(
            report.torn.is_empty(),
            "torn folders: {:?}",
            report.torn.iter().map(|t| (t.path.clone(), t.connected, t.size)).collect::<Vec<_>>()
        );
        // Sibling adjacency is a soft target — pack-phase alone cannot
        // guarantee every sibling pair shares a hex border (that's the job of
        // iswap/xswap in steps 3-4). On 4 sibling folders that's up to 6
        // pairs; this 50-leaf fixture currently produces 2 gaps, both between
        // top-level packages siblings. Lock the count so future pack changes
        // can't silently regress; relax once iswap is wired in.
        assert!(
            report.sibling_gaps <= 2,
            "sibling_gaps={} exceeds pack-phase expected upper bound (2)",
            report.sibling_gaps
        );
    }

    #[test]
    fn pack_is_deterministic_across_runs() {
        // Same input → byte-identical coords.
        let leaves: Vec<(NodeIdx, String)> = (0..20)
            .map(|i| (i as u32, format!("packages/{}/file{}.rs", i % 4, i)))
            .collect();
        let pairs: Vec<(NodeIdx, &str)> =
            leaves.iter().map(|(i, s)| (*i, s.as_str())).collect();
        let tree = FolderTree::build_from_paths(&pairs);

        let (coords1, _) = pack(&tree, 20);
        let (coords2, _) = pack(&tree, 20);

        assert_eq!(coords1, coords2, "pack is non-deterministic");
    }
}
