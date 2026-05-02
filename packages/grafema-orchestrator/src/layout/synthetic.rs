//! Deterministic synthetic input for layout benchmarks and CLI dry-runs.
//!
//! Generates a [`LayoutInput`] (folder tree + edge list) that mimics the
//! shape of a real codebase — a handful of top-level packages, ~3 levels of
//! sub-folders, and a mix of intra- and cross-folder edges. This lets the
//! `layout` CLI subcommand exercise the full pack → iswap → xswap pipeline
//! end-to-end without RFDB integration. The same struct is also produced by
//! [`super::loader::load_from_rfdb`] for real RFDB-backed runs (step 6).
//!
//! Design constraints:
//! * **Deterministic.** Same `(n_leaves, seed, edge_density)` → byte-identical
//!   output. Uses a small LCG (`mulberry32`-style) seeded from `seed` so we
//!   don't drag in a heavyweight rng dep for what's essentially a fixture.
//! * **Realistic clustering.** Leaves are spread across a small alphabet of
//!   folder names so many leaves end up sharing a folder — the same property
//!   the pack algorithm exploits in real codebases.
//! * **Edge bias.** 70% of edges are intra-folder (mirrors the `tree-sample.js`
//!   reference fixture). The remaining 30% are uniform across the whole graph
//!   to give iswap/xswap a meaningful workload.
//!
//! Mirrors the spirit of `sandbox/hex-sandbox/src/tree-sample.js:103-153`,
//! adapted for Rust types and the [`FolderTree`]/[`Edge`] shapes the pack
//! pipeline expects.

use rustc_hash::FxHashSet;

use super::edges::Edge;
use super::state::NodeIdx;
use super::tree::FolderTree;

/// Folder-name vocabulary. Two- or three-deep nesting from this alphabet
/// gives realistic clustering on small input sizes (50–10k leaves).
const LEVEL1: &[&str] = &["packages", "apps", "tools"];
const LEVEL2: &[&str] = &["api", "core", "util", "io", "test", "bench", "ui"];
const LEVEL3: &[&str] = &["src", "lib", "mod", "impl"];

/// Input ready to feed into [`super::run_layout`].
///
/// Produced either by [`generate`] (deterministic synthetic fixture) or by
/// [`super::loader::load_from_rfdb`] (real RFDB-backed graph). Both sources
/// share this shape so the runner stays source-agnostic.
///
/// `n_nodes` matches `tree`'s leaf count (kept as a separate field for
/// callers that need the count without walking the tree).
pub struct LayoutInput {
    /// Folder hierarchy with leaves placed at depth 4 (`L1/L2/L3/file*.rs`).
    pub tree: FolderTree,
    /// Edge list (intra- and cross-folder mix). Length ≈ `n_nodes × edge_density`
    /// after dedup — slightly less because self-loops and duplicate pairs are
    /// dropped.
    pub edges: Vec<Edge>,
    /// Total leaf count == `coords.len()` after `pack`.
    pub n_nodes: usize,
    /// Per-leaf path strings, indexed by `NodeIdx`. Used by the JSON dumper
    /// to label coords with human-readable identifiers.
    pub leaf_paths: Vec<String>,
    /// MODULE semantic IDs in [`NodeIdx`] order. `Some(_)` for RFDB-loaded
    /// inputs (one entry per leaf, parallel to [`leaf_paths`]); `None` for
    /// synthetic fixtures (where leaf paths are not real semantic IDs and
    /// nothing in RFDB matches them).
    ///
    /// Required by [`super::commit::commit_layout`] — without it, we can't
    /// emit `LAYOUT_POSITION` edges keyed by MODULE id.
    pub semantic_ids: Option<Vec<String>>,
    /// RFDB node ids (u128, BLAKE3 of semantic id) parallel to `semantic_ids`.
    /// `Some(_)` for RFDB-loaded inputs; `None` for synthetic.
    pub rfdb_ids: Option<Vec<u128>>,
    /// Liftable-edge degree (incoming + outgoing, counted only over the edge
    /// types defined in `loader::LIFTABLE_EDGE_TYPES`) parallel to
    /// `semantic_ids`. Feeds the degree-desc hard-cap tiebreak in Chunk-2.
    /// `Some(_)` for RFDB-loaded inputs; `None` for synthetic.
    pub degrees: Option<Vec<u32>>,
}

impl LayoutInput {
    /// Iterate `(NodeIdx, &str)` pairs in stable insertion order.
    ///
    /// Returns the same shape `FolderTree::build_from_paths` expects, so the
    /// JSON dumper can re-thread leaf identifiers without re-allocating.
    pub fn iter_leaf_paths(&self) -> impl Iterator<Item = (NodeIdx, &str)> {
        self.leaf_paths
            .iter()
            .enumerate()
            .map(|(i, p)| (i as NodeIdx, p.as_str()))
    }
}

/// Generate a deterministic synthetic [`LayoutInput`].
///
/// `n_leaves` controls graph size (0 → empty tree with only the root folder).
/// `seed` drives the rng — same `(n_leaves, seed, edge_density)` → identical
/// output. `edge_density` is the average edges-per-leaf multiplier; the actual
/// edge count after self-loop and duplicate-pair removal is usually within
/// ~15% of `n_leaves * edge_density`.
pub fn generate(n_leaves: usize, seed: u64, edge_density: f32) -> LayoutInput {
    let mut rng = Lcg::new(seed);

    // ── Leaf paths ─────────────────────────────────────────────────────────
    // Deterministic vocabulary draw from L1/L2/L3 for each leaf, then a
    // unique `file{i}.rs` filename so paths collide on the parent dir only.
    let mut leaf_paths: Vec<String> = Vec::with_capacity(n_leaves);
    for i in 0..n_leaves {
        let l1 = LEVEL1[(rng.next_u32() as usize) % LEVEL1.len()];
        let l2 = LEVEL2[(rng.next_u32() as usize) % LEVEL2.len()];
        let l3 = LEVEL3[(rng.next_u32() as usize) % LEVEL3.len()];
        leaf_paths.push(format!("{}/{}/{}/file{}.rs", l1, l2, l3, i));
    }

    let pairs: Vec<(NodeIdx, &str)> = leaf_paths
        .iter()
        .enumerate()
        .map(|(i, p)| (i as NodeIdx, p.as_str()))
        .collect();
    let tree = FolderTree::build_from_paths(&pairs);

    // ── Per-leaf folder lookup for intra-folder bias ───────────────────────
    // Indexed by NodeIdx → folder path. Used to find sibling candidates when
    // the rng's coin flip picks "intra-folder".
    let node_to_folder = tree.node_to_folder(n_leaves);
    // Per-folder list of NodeIdx, so an intra-folder pick is `O(1)` after
    // we know the folder.
    let mut by_folder: Vec<Vec<NodeIdx>> = vec![Vec::new(); tree.len()];
    for (idx, fid) in node_to_folder.iter().enumerate() {
        if (*fid as usize) < tree.len() {
            by_folder[*fid as usize].push(idx as NodeIdx);
        }
    }

    // ── Edges ──────────────────────────────────────────────────────────────
    // Target count = round(n_leaves * edge_density). Each edge has a 70%
    // intra-folder bias (matching the `tree-sample.js` reference fixture).
    // We dedup on unordered (min, max) pairs so a 1-2 edge and a 2-1 edge
    // count as the same.
    let target_edges = ((n_leaves as f32) * edge_density).round() as usize;
    let mut edges: Vec<Edge> = Vec::with_capacity(target_edges);
    let mut seen: FxHashSet<(NodeIdx, NodeIdx)> = FxHashSet::default();

    if n_leaves >= 2 {
        // Allow up to ~1.5× target attempts so dedup losses don't starve
        // the pool. Any unreachable edges (small graphs, dense duplicates)
        // simply land us slightly under target.
        let max_attempts = target_edges.saturating_mul(3) / 2;
        for _ in 0..max_attempts {
            if edges.len() >= target_edges {
                break;
            }
            let src = (rng.next_u32() as usize) % n_leaves;
            // 70% intra-folder, 30% uniform across all leaves.
            let dst = if rng.next_u32() % 100 < 70 {
                let fid = node_to_folder[src] as usize;
                let folder_nodes = &by_folder[fid];
                if folder_nodes.len() >= 2 {
                    folder_nodes[(rng.next_u32() as usize) % folder_nodes.len()] as usize
                } else {
                    (rng.next_u32() as usize) % n_leaves
                }
            } else {
                (rng.next_u32() as usize) % n_leaves
            };

            if src == dst {
                continue;
            }
            // Canonical ordering for the dedup key: smaller first.
            let key = if src < dst {
                (src as NodeIdx, dst as NodeIdx)
            } else {
                (dst as NodeIdx, src as NodeIdx)
            };
            if !seen.insert(key) {
                continue;
            }

            // Weight in {1, 2, 3} — small integers keep Σ link length math
            // tidy in the report output.
            let weight = ((rng.next_u32() % 3) + 1) as f32;
            edges.push(Edge {
                src: src as NodeIdx,
                dst: dst as NodeIdx,
                weight,
            });
        }
    }

    LayoutInput {
        tree,
        edges,
        n_nodes: n_leaves,
        leaf_paths,
        // Synthetic mode never knows real semantic IDs — leaf paths are
        // synthesised from the folder vocabulary and don't correspond to any
        // MODULE node in any RFDB.
        semantic_ids: None,
        rfdb_ids: None,
        degrees: None,
    }
}

/// Linear-congruential generator. Numerical Recipes coefficients —
/// good enough for fixture generation, byte-identical across machines.
///
/// We keep the rng local rather than depend on `rand` to avoid a heavy
/// dependency for what's purely an internal benchmarking helper.
struct Lcg {
    state: u64,
}

impl Lcg {
    fn new(seed: u64) -> Self {
        // Avoid the all-zero state which would freeze the LCG.
        Self {
            state: seed.wrapping_add(0x9E37_79B9_7F4A_7C15),
        }
    }

    fn next_u32(&mut self) -> u32 {
        self.state = self
            .state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.state >> 32) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_input_produces_reasonable_tree_and_edges() {
        let input = generate(50, 42, 1.5);

        assert_eq!(input.n_nodes, 50);
        assert_eq!(input.leaf_paths.len(), 50);

        // Tree has more than just the root — with 50 leaves and 3-level
        // vocabulary we expect at least a handful of folders.
        assert!(
            input.tree.len() >= 3,
            "expected ≥3 folders for 50 leaves, got {}",
            input.tree.len()
        );
        assert!(
            input.tree.max_depth() >= 2,
            "expected max depth ≥ 2, got {}",
            input.tree.max_depth()
        );

        // Edge count ≈ 50 × 1.5 = 75 (allow 30% slack for dedup losses on
        // small graphs where the intra-folder pool is tiny).
        let target = 75;
        let lower = (target as f32 * 0.5) as usize;
        let upper = (target as f32 * 1.2) as usize;
        assert!(
            input.edges.len() >= lower && input.edges.len() <= upper,
            "edge count {} outside expected band [{}, {}]",
            input.edges.len(),
            lower,
            upper
        );

        // No self-loops.
        for e in &input.edges {
            assert_ne!(e.src, e.dst, "self-loop slipped through");
        }
    }

    #[test]
    fn determinism_same_seed_same_output() {
        let a = generate(100, 1234, 2.0);
        let b = generate(100, 1234, 2.0);

        assert_eq!(a.n_nodes, b.n_nodes);
        assert_eq!(a.leaf_paths, b.leaf_paths, "leaf paths must match");
        assert_eq!(a.edges.len(), b.edges.len(), "edge count must match");
        for (ea, eb) in a.edges.iter().zip(b.edges.iter()) {
            assert_eq!(ea, eb, "edges must match exactly");
        }
        assert_eq!(a.tree.len(), b.tree.len(), "tree structure must match");
        for fid in 0..a.tree.len() {
            let fa = a.tree.get(fid as u32);
            let fb = b.tree.get(fid as u32);
            assert_eq!(fa.path, fb.path);
            assert_eq!(fa.depth, fb.depth);
            assert_eq!(fa.parent, fb.parent);
            assert_eq!(fa.direct_leaves, fb.direct_leaves);
            assert_eq!(fa.transitive_size, fb.transitive_size);
        }
    }

    #[test]
    fn different_seeds_produce_different_outputs() {
        let a = generate(50, 1, 1.5);
        let b = generate(50, 2, 1.5);
        // Some divergence in either tree shape or edges.
        let trees_differ = (0..a.tree.len().min(b.tree.len()))
            .any(|i| a.tree.get(i as u32).direct_leaves != b.tree.get(i as u32).direct_leaves);
        let edges_differ = a.edges != b.edges;
        let paths_differ = a.leaf_paths != b.leaf_paths;
        assert!(
            trees_differ || edges_differ || paths_differ,
            "different seeds gave identical outputs — rng is broken"
        );
    }

    #[test]
    fn empty_input_produces_empty_tree_and_edges() {
        let input = generate(0, 42, 1.5);
        assert_eq!(input.n_nodes, 0);
        assert!(input.leaf_paths.is_empty());
        assert!(input.edges.is_empty());
        // Tree only contains the synthetic root.
        assert_eq!(input.tree.len(), 1);
        assert_eq!(input.tree.get(input.tree.root()).path, ".");
    }

    #[test]
    fn iter_leaf_paths_threads_indices_correctly() {
        let input = generate(10, 7, 1.0);
        let pairs: Vec<(NodeIdx, &str)> = input.iter_leaf_paths().collect();
        assert_eq!(pairs.len(), 10);
        for (i, (idx, path)) in pairs.iter().enumerate() {
            assert_eq!(*idx, i as NodeIdx);
            assert_eq!(*path, input.leaf_paths[i].as_str());
        }
    }
}
