//! Pack topology validator — Rust port of `sandbox/hex-sandbox/src/pack.js:953-1024`.
//!
//! Two structural invariants the pack phase aims to satisfy:
//! 1. **Per-folder connectivity.** Every folder's transitive tile-set must be
//!    hex-connected (BFS from any node reaches all others). Folders that
//!    violate this are "torn" — they appear visually fragmented on the map.
//! 2. **Sibling adjacency.** For every parent folder with ≥2 children, each
//!    pair of children should share at least one hex border. Pairs that don't
//!    are counted as `sibling_gaps`.
//!
//! Both checks operate purely on the resolved `coords` vector + `FolderTree`
//! — no `PlacementState` needed because per-folder cell sets are derived from
//! coords + leaf-to-folder membership.
//!
//! ## Output
//!
//! [`ValidationReport`] holds both counts and the per-folder torn details, and
//! its `Display` impl reproduces the JS log format exactly:
//!
//! ```text
//! pack validation: torn=2  sibling_gaps=3
//!   torn: packages/foo (3/5 connected)
//!   torn: packages/bar (4/7 connected)
//! ```

use std::collections::VecDeque;
use std::fmt;

use rustc_hash::FxHashSet;

use super::hex::{pack_key, HexCoord, HEX_DIRS};
use super::tree::{FolderId, FolderTree};

/// One folder that failed the connectivity check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TornFolder {
    /// Folder path (e.g. `"packages/util/src"`).
    pub path: String,
    /// Total number of nodes in the folder transitively.
    pub size: usize,
    /// Number of nodes the BFS from the first node was able to reach.
    /// Always `< size` (otherwise the folder wouldn't be torn).
    pub connected: usize,
}

/// Result of [`validate`]. Used by `pack`/`xswap` callers and printed via
/// [`fmt::Display`] for log output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationReport {
    /// Folders whose tile sets are not hex-connected.
    pub torn: Vec<TornFolder>,
    /// Number of sibling-folder pairs that don't share a hex border.
    pub sibling_gaps: u32,
}

impl fmt::Display for ValidationReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            f,
            "pack validation: torn={}  sibling_gaps={}",
            self.torn.len(),
            self.sibling_gaps
        )?;
        for t in &self.torn {
            writeln!(f, "  torn: {} ({}/{} connected)", t.path, t.connected, t.size)?;
        }
        Ok(())
    }
}

/// Validate a pack result. See module docs for the two checks.
///
/// Time complexity: `O(F + N · D)` where `F` is folder count, `N` is node
/// count, and `D` is max folder depth (each node propagates up its ancestor
/// chain). Memory is dominated by the per-folder coord sets — at most `O(N · D)`.
pub fn validate(coords: &[HexCoord], tree: &FolderTree) -> ValidationReport {
    // ── Step 1: per-folder transitive coord lists ──────────────────────
    // Mirrors pack.js:957-970. For every node, walk up the parent chain
    // pushing into each ancestor's list.
    //
    // We need (a) a coord-set for membership tests during BFS and pair
    // adjacency, and (b) a coord list to anchor the BFS at the first node.
    let n_folders = tree.len();
    let mut folder_coords: Vec<Vec<HexCoord>> = vec![Vec::new(); n_folders];
    let mut folder_coord_set: Vec<FxHashSet<i64>> = vec![FxHashSet::default(); n_folders];

    for (folder_id, folder) in tree.iter() {
        for leaf_idx in &folder.direct_leaves {
            let coord = coords[*leaf_idx as usize];
            let key = pack_key(coord.q, coord.r);
            // Walk up the ancestor chain pushing the coord into each ancestor.
            let mut cursor: Option<FolderId> = Some(folder_id);
            while let Some(id) = cursor {
                folder_coords[id as usize].push(coord);
                folder_coord_set[id as usize].insert(key);
                cursor = tree.get(id).parent;
            }
        }
    }

    // ── Step 2: torn folders ───────────────────────────────────────────
    // Mirrors pack.js:973-994. For every folder with ≥2 nodes, BFS via
    // hex neighbours within the coord set; count torn if BFS reaches fewer
    // than total.
    let mut torn = Vec::new();
    for (folder_id, folder) in tree.iter() {
        let coords_list = &folder_coords[folder_id as usize];
        let coords_set = &folder_coord_set[folder_id as usize];
        if coords_list.len() <= 1 {
            continue;
        }
        // The set's len is the unique-cell count; coords_list may contain
        // duplicates only if two nodes share a coord, which the pack guards
        // against — but use the set as the authoritative size to mirror JS.
        let total = coords_set.len();

        let mut seen: FxHashSet<i64> = FxHashSet::default();
        let mut queue: VecDeque<HexCoord> = VecDeque::new();
        let first = coords_list[0];
        seen.insert(pack_key(first.q, first.r));
        queue.push_back(first);
        while let Some(cur) = queue.pop_front() {
            for d in HEX_DIRS.iter() {
                let nq = cur.q + d.q;
                let nr = cur.r + d.r;
                let k = pack_key(nq, nr);
                if coords_set.contains(&k) && !seen.contains(&k) {
                    seen.insert(k);
                    queue.push_back(HexCoord::new(nq, nr));
                }
            }
        }
        if seen.len() != total {
            torn.push(TornFolder {
                path: folder.path.clone(),
                size: total,
                connected: seen.len(),
            });
        }
    }

    // ── Step 3: sibling-pair adjacency ─────────────────────────────────
    // Mirrors pack.js:996-1021. For every parent folder, look at the
    // unordered pairs of its non-empty children and count pairs that don't
    // share a hex border.
    let mut sibling_gaps: u32 = 0;
    for (_parent_id, parent) in tree.iter() {
        // Snapshot children that have any cells; skip pairs of empty.
        let non_empty: Vec<FolderId> = parent
            .child_folders
            .iter()
            .copied()
            .filter(|cid| !folder_coord_set[*cid as usize].is_empty())
            .collect();
        if non_empty.len() < 2 {
            continue;
        }
        for i in 0..non_empty.len() {
            let a = &folder_coord_set[non_empty[i] as usize];
            for j in (i + 1)..non_empty.len() {
                let b = &folder_coord_set[non_empty[j] as usize];
                // Iterate the smaller set for cache friendliness.
                let (small, large) = if a.len() <= b.len() { (a, b) } else { (b, a) };
                let mut adj = false;
                'outer: for key in small {
                    let (q, r) = super::hex::unpack_key(*key);
                    for d in HEX_DIRS.iter() {
                        if large.contains(&pack_key(q + d.q, r + d.r)) {
                            adj = true;
                            break 'outer;
                        }
                    }
                }
                if !adj {
                    sibling_gaps += 1;
                }
            }
        }
    }

    ValidationReport { torn, sibling_gaps }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::tree::FolderTree;

    #[test]
    fn empty_input_no_torn_no_gaps() {
        let tree = FolderTree::build_from_paths(&[]);
        let coords: Vec<HexCoord> = Vec::new();
        let report = validate(&coords, &tree);
        assert!(report.torn.is_empty(), "expected no torn, got {:?}", report.torn);
        assert_eq!(report.sibling_gaps, 0);
    }

    #[test]
    fn three_nodes_in_one_folder_connected_layout_not_torn() {
        // Folder "a" has three nodes at (0,0), (1,0), (0,1) — all pairwise adj.
        let inputs = [(0u32, "a/x.rs"), (1u32, "a/y.rs"), (2u32, "a/z.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        let coords = vec![
            HexCoord::new(0, 0),
            HexCoord::new(1, 0),
            HexCoord::new(0, 1),
        ];
        let report = validate(&coords, &tree);
        assert!(report.torn.is_empty(), "expected no torn folders, got {:?}", report.torn);
        assert_eq!(report.sibling_gaps, 0);
    }

    #[test]
    fn three_nodes_one_isolated_is_torn() {
        // Folder "a" has three nodes; (10,10) is isolated from (0,0)/(1,0).
        // Both "a" AND "." are torn — the validator walks up the parent chain
        // (mirrors pack.js:962-969), so root contains the same disconnected set.
        let inputs = [(0u32, "a/x.rs"), (1u32, "a/y.rs"), (2u32, "a/z.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        let coords = vec![
            HexCoord::new(0, 0),
            HexCoord::new(1, 0),
            HexCoord::new(10, 10),
        ];
        let report = validate(&coords, &tree);
        // Find folder "a" specifically.
        let a = report
            .torn
            .iter()
            .find(|t| t.path == "a")
            .expect("folder 'a' should be in torn list");
        assert_eq!(a.size, 3, "all three nodes counted in folder a");
        assert_eq!(a.connected, 2, "BFS reaches only the two adjacent nodes");
        // Root "." also torn for the same reason.
        let root = report
            .torn
            .iter()
            .find(|t| t.path == ".")
            .expect("root '.' should be in torn list (inherits from a)");
        assert_eq!(root.size, 3);
        assert_eq!(root.connected, 2);
    }

    #[test]
    fn sibling_gap_detected_when_two_subfolders_far_apart() {
        // Folder "p" with two children "p/a" and "p/b". Place them far apart →
        // 1 sibling gap (p's children) AND torn root + torn "p" (each contains
        // both nodes which are not hex-adjacent).
        let inputs = [(0u32, "p/a/x.rs"), (1u32, "p/b/y.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        let coords = vec![HexCoord::new(0, 0), HexCoord::new(5, 5)];
        let report = validate(&coords, &tree);
        // Children "p/a" and "p/b" each have only 1 leaf so they're not torn,
        // but "p" and "." each have 2 disconnected leaves → torn.
        let torn_paths: Vec<&str> = report.torn.iter().map(|t| t.path.as_str()).collect();
        assert!(torn_paths.contains(&"p"), "p should be torn, got {:?}", torn_paths);
        assert!(torn_paths.contains(&"."), ". should be torn, got {:?}", torn_paths);
        // The sibling-pair check fires once: "p/a" vs "p/b" don't share a border.
        assert_eq!(report.sibling_gaps, 1, "expected one sibling gap");
    }

    #[test]
    fn display_format_matches_pack_js() {
        let report = ValidationReport {
            torn: vec![TornFolder {
                path: "packages/foo".to_string(),
                size: 5,
                connected: 3,
            }],
            sibling_gaps: 2,
        };
        let s = format!("{}", report);
        assert!(s.contains("pack validation: torn=1  sibling_gaps=2"),
            "header line wrong, got: {:?}", s);
        assert!(s.contains("  torn: packages/foo (3/5 connected)"),
            "torn line wrong, got: {:?}", s);
    }

    #[test]
    fn nested_folder_propagation_includes_descendants() {
        // p/a has 1 leaf, p/b has 1 leaf. Parent "p" should see both.
        // Place them adjacent so neither child nor parent is torn.
        let inputs = [(0u32, "p/a/x.rs"), (1u32, "p/b/y.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        let coords = vec![HexCoord::new(0, 0), HexCoord::new(1, 0)];
        let report = validate(&coords, &tree);
        assert!(report.torn.is_empty(), "no torn expected");
        assert_eq!(report.sibling_gaps, 0, "siblings are adjacent");
    }
}
