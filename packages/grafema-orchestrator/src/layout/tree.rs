//! Folder hierarchy derived from leaf file paths.
//!
//! Mirrors `buildFolderTree` in `sandbox/hex-sandbox/src/pack.js:52-98` but uses
//! integer `FolderId` indices into a `Vec<Folder>` instead of a `Map<String,_>`,
//! and uses `NodeIdx` (u32) for leaves instead of node objects.
//!
//! The root folder is always `FolderId(0)` with path `"."` and depth 0.
//! All `child_folders` and `direct_leaves` lists are sorted for determinism so
//! identical input produces a byte-identical `FolderTree`.

use rustc_hash::FxHashMap;

use super::state::NodeIdx;

/// Stable index into the `FolderTree.folders` vec. Index 0 is reserved for root.
pub type FolderId = u32;

/// A single folder in the hierarchy.
pub struct Folder {
    /// Slash-joined path relative to the project root; `"."` for the root.
    pub path: String,
    /// Depth from the root (root = 0).
    pub depth: u32,
    /// Parent folder id, or `None` for the root.
    pub parent: Option<FolderId>,
    /// Child folder ids, sorted by `Folder.path`.
    pub child_folders: Vec<FolderId>,
    /// Leaves directly contained in this folder (not in a sub-folder),
    /// sorted by `NodeIdx` ascending.
    pub direct_leaves: Vec<NodeIdx>,
    /// `direct_leaves.len()` plus the sum of all descendants' direct leaf counts.
    pub transitive_size: u32,
}

/// Hierarchical folder tree built from leaf file paths.
pub struct FolderTree {
    folders: Vec<Folder>,
    by_path: FxHashMap<String, FolderId>,
}

impl FolderTree {
    /// Build a tree from `(node_idx, leaf_relative_file_path)` pairs.
    ///
    /// For each leaf the folder is the parent directory of its file path
    /// (e.g. `"packages/util/src"` for `"packages/util/src/index.ts"`).
    /// Files at the project root collapse to the synthetic `"."` folder.
    ///
    /// Algorithm follows `pack.js:buildFolderTree` exactly:
    /// 1. Ensure root folder `"."` at depth 0.
    /// 2. For each leaf, walk path components creating any missing intermediates.
    /// 3. Push the leaf into its deepest folder's `direct_leaves`.
    /// 4. Bottom-up `transitive_size` (`direct_leaves.len()` + Σ children).
    /// 5. Sort `direct_leaves` by `NodeIdx` and `child_folders` by `Folder.path`
    ///    for determinism.
    pub fn build_from_paths(leaf_paths: &[(NodeIdx, &str)]) -> Self {
        let mut tree = FolderTree {
            folders: Vec::new(),
            by_path: FxHashMap::default(),
        };
        // Always create the root.
        tree.ensure_folder(".".to_string(), 0, None);

        for (node_idx, file_path) in leaf_paths {
            let folder_path = parent_dir(file_path);
            let folder_id = if folder_path == "." {
                0
            } else {
                tree.ensure_path_chain(&folder_path)
            };
            tree.folders[folder_id as usize].direct_leaves.push(*node_idx);
        }

        tree.compute_transitive_sizes();
        tree.sort_for_determinism();
        tree
    }

    /// Build a tree from `(node_idx, folder_path, opaque_leaf_id)` triples.
    ///
    /// Unlike [`build_from_paths`] (where the file path IS the leaf locator and
    /// its parent directory becomes the folder), here the `folder_path` is
    /// itself the deepest folder — the file becomes the innermost folder
    /// (last `/`-segment). The `leaf_id` is OPAQUE and used only for
    /// deterministic intra-folder lex ordering and debug logging; it is never
    /// parsed or split. This lets RFDB V2 semantic IDs (which may contain `/`
    /// as part of the id) survive intact.
    ///
    /// If two triples share the same `leaf_id` within a folder, a warning is
    /// logged and the later entry is silently dropped (defensive; globally
    /// unique semantic IDs should make this unreachable in healthy inputs).
    ///
    /// NodeIdx values are the caller's responsibility — they should be dense
    /// `0..N` over the placeable-symbol set passed in; this builder does not
    /// renumber.
    pub fn build_from_paths_with_leaves(
        leaf_pairs: &[(NodeIdx, &str, &str)],
    ) -> Self {
        let mut tree = FolderTree {
            folders: Vec::new(),
            by_path: FxHashMap::default(),
        };
        tree.ensure_folder(".".to_string(), 0, None);

        // Folder id → set of leaf_ids already seen, for dedup.
        let mut seen_per_folder: FxHashMap<FolderId, FxHashMap<String, NodeIdx>> =
            FxHashMap::default();
        // Parallel leaf_id vector indexed by NodeIdx, for lex sort tiebreak.
        let max_idx = leaf_pairs.iter().map(|(i, _, _)| *i).max().unwrap_or(0);
        let mut leaf_ids_by_idx: Vec<String> = vec![String::new(); (max_idx as usize) + 1];

        for (node_idx, folder_path, leaf_id) in leaf_pairs {
            let folder_id = if *folder_path == "." || folder_path.is_empty() {
                0
            } else {
                tree.ensure_path_chain(folder_path)
            };
            let seen = seen_per_folder.entry(folder_id).or_default();
            if let Some(&prior_idx) = seen.get(*leaf_id) {
                tracing::warn!(
                    leaf_id = %leaf_id,
                    folder_path = %folder_path,
                    prior_idx = prior_idx,
                    dup_idx = *node_idx,
                    "duplicate leaf_id in folder — keeping first, dropping duplicate"
                );
                continue;
            }
            seen.insert(leaf_id.to_string(), *node_idx);
            if (*node_idx as usize) < leaf_ids_by_idx.len() {
                leaf_ids_by_idx[*node_idx as usize] = leaf_id.to_string();
            }
            tree.folders[folder_id as usize].direct_leaves.push(*node_idx);
        }

        tree.compute_transitive_sizes();
        tree.sort_for_determinism_with_leaves(&leaf_ids_by_idx);
        tree
    }

    /// Root folder id (always 0).
    pub fn root(&self) -> FolderId {
        0
    }

    /// Borrow a folder by id.
    pub fn get(&self, id: FolderId) -> &Folder {
        &self.folders[id as usize]
    }

    /// Iterate over all `(id, folder)` pairs in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (FolderId, &Folder)> {
        self.folders
            .iter()
            .enumerate()
            .map(|(i, f)| (i as FolderId, f))
    }

    /// Maximum depth across all folders.
    pub fn max_depth(&self) -> u32 {
        self.folders.iter().map(|f| f.depth).max().unwrap_or(0)
    }

    /// Lookup a folder id by path (`"."` for root). `None` if no such folder.
    pub fn folder_id(&self, path: &str) -> Option<FolderId> {
        self.by_path.get(path).copied()
    }

    /// Number of folders (including the synthetic root).
    pub fn len(&self) -> usize {
        self.folders.len()
    }

    /// Whether the tree contains only the root folder.
    pub fn is_empty(&self) -> bool {
        self.folders.len() <= 1 && self.folders[0].direct_leaves.is_empty()
    }

    /// Map every `NodeIdx` (`0..n_nodes`) to its leaf [`FolderId`].
    ///
    /// Walks every folder's `direct_leaves` and writes the folder id at the
    /// matching node index. A node belongs to exactly one folder so collisions
    /// are impossible.
    ///
    /// `NodeIdx` values not present in any folder's `direct_leaves` keep the
    /// sentinel `FolderId::MAX` — defensive against pathological inputs;
    /// pack-produced inputs assign every node so this should never trigger.
    ///
    /// Used by `iswap` and `xswap` to group nodes by leaf folder and (for
    /// xswap) to look up a node's folder when scanning boundary neighbours.
    pub fn node_to_folder(&self, n_nodes: usize) -> Vec<FolderId> {
        let mut node_to_folder: Vec<FolderId> = vec![FolderId::MAX; n_nodes];
        for (fid, folder) in self.iter() {
            for leaf_idx in &folder.direct_leaves {
                node_to_folder[*leaf_idx as usize] = fid;
            }
        }
        node_to_folder
    }

    // ── internals ──────────────────────────────────────────────────────────

    /// Get-or-create a folder by exact path. Does not parse `path`.
    fn ensure_folder(&mut self, path: String, depth: u32, parent: Option<FolderId>) -> FolderId {
        if let Some(&id) = self.by_path.get(&path) {
            return id;
        }
        let id = self.folders.len() as FolderId;
        self.by_path.insert(path.clone(), id);
        self.folders.push(Folder {
            path,
            depth,
            parent,
            child_folders: Vec::new(),
            direct_leaves: Vec::new(),
            transitive_size: 0,
        });
        id
    }

    /// Walk the slash-separated chain `a/b/c`, creating any missing folders
    /// (and parent→child links). Returns the id of the deepest folder.
    fn ensure_path_chain(&mut self, folder_path: &str) -> FolderId {
        let mut parent_id: FolderId = 0;
        let mut acc: String = String::new();
        for (depth, part) in folder_path.split('/').enumerate() {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            let depth = (depth + 1) as u32;
            let id = self.ensure_folder(acc.clone(), depth, Some(parent_id));
            // Link parent → child (no duplicate add; parent_folder.child_folders is
            // sorted later, so order here is irrelevant).
            let parent_children = &mut self.folders[parent_id as usize].child_folders;
            if !parent_children.contains(&id) {
                parent_children.push(id);
            }
            parent_id = id;
        }
        parent_id
    }

    /// Bottom-up fill of `transitive_size` (sort by depth descending, accumulate).
    fn compute_transitive_sizes(&mut self) {
        let mut order: Vec<FolderId> = (0..self.folders.len() as FolderId).collect();
        order.sort_by(|a, b| {
            self.folders[*b as usize]
                .depth
                .cmp(&self.folders[*a as usize].depth)
        });
        for id in order {
            let direct = self.folders[id as usize].direct_leaves.len() as u32;
            // Snapshot children ids to avoid borrow conflict.
            let children: Vec<FolderId> = self.folders[id as usize].child_folders.clone();
            let child_sum: u32 = children
                .iter()
                .map(|c| self.folders[*c as usize].transitive_size)
                .sum();
            self.folders[id as usize].transitive_size = direct + child_sum;
        }
    }

    /// Sort `direct_leaves` by `NodeIdx` and `child_folders` by `Folder.path`.
    fn sort_for_determinism(&mut self) {
        // Snapshot the path for each id so we can sort children by path
        // without conflicting borrows.
        let paths: Vec<String> = self.folders.iter().map(|f| f.path.clone()).collect();
        for f in &mut self.folders {
            f.direct_leaves.sort_unstable();
            f.child_folders
                .sort_by(|a, b| paths[*a as usize].cmp(&paths[*b as usize]));
        }
    }

    /// Like `sort_for_determinism`, but lex-sorts `direct_leaves` by their
    /// opaque `leaf_id` (tiebroken by `NodeIdx`) rather than purely by
    /// `NodeIdx`. Used when the caller carries RFDB semantic ids as the
    /// canonical stable order.
    fn sort_for_determinism_with_leaves(&mut self, leaf_ids: &[String]) {
        let paths: Vec<String> = self.folders.iter().map(|f| f.path.clone()).collect();
        for f in &mut self.folders {
            f.direct_leaves.sort_by(|a, b| {
                let ka = leaf_ids.get(*a as usize).map(String::as_str).unwrap_or("");
                let kb = leaf_ids.get(*b as usize).map(String::as_str).unwrap_or("");
                ka.cmp(kb).then_with(|| a.cmp(b))
            });
            f.child_folders
                .sort_by(|a, b| paths[*a as usize].cmp(&paths[*b as usize]));
        }
    }
}

/// Return the parent directory of `file_path`, using `"."` for the root.
///
/// Examples:
/// * `"a/b.rs"` → `"a"`
/// * `"x/y/z.txt"` → `"x/y"`
/// * `"top.md"` → `"."`
fn parent_dir(file_path: &str) -> String {
    match file_path.rfind('/') {
        Some(idx) => file_path[..idx].to_string(),
        None => ".".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_only_root() {
        let tree = FolderTree::build_from_paths(&[]);
        assert_eq!(tree.len(), 1);
        let root = tree.get(tree.root());
        assert_eq!(root.path, ".");
        assert_eq!(root.depth, 0);
        assert_eq!(root.parent, None);
        assert!(root.child_folders.is_empty());
        assert!(root.direct_leaves.is_empty());
        assert_eq!(root.transitive_size, 0);
        assert_eq!(tree.max_depth(), 0);
        assert!(tree.is_empty());
    }

    #[test]
    fn three_flat_leaves_under_root() {
        let inputs = [(2, "c.rs"), (0, "a.rs"), (1, "b.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        assert_eq!(tree.len(), 1);
        let root = tree.get(tree.root());
        // Sorted by NodeIdx ascending.
        assert_eq!(root.direct_leaves, vec![0, 1, 2]);
        assert!(root.child_folders.is_empty());
        assert_eq!(root.transitive_size, 3);
        assert_eq!(tree.max_depth(), 0);
    }

    #[test]
    fn two_top_level_folders_plus_root_sizes() {
        let inputs = [(0, "a/b.rs"), (1, "a/c.rs"), (2, "x/y.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        assert_eq!(tree.len(), 3, "expected . + a + x");
        let root = tree.get(tree.root());
        assert_eq!(root.transitive_size, 3);
        assert_eq!(root.direct_leaves, Vec::<NodeIdx>::new());
        assert_eq!(root.child_folders.len(), 2);

        let a_id = tree.folder_id("a").expect("folder a missing");
        let x_id = tree.folder_id("x").expect("folder x missing");

        // Children sorted by path: "a" before "x".
        let child_paths: Vec<&str> = root
            .child_folders
            .iter()
            .map(|id| tree.get(*id).path.as_str())
            .collect();
        assert_eq!(child_paths, vec!["a", "x"]);

        let a = tree.get(a_id);
        assert_eq!(a.depth, 1);
        assert_eq!(a.parent, Some(0));
        assert_eq!(a.transitive_size, 2);
        assert_eq!(a.direct_leaves, vec![0, 1]);
        assert!(a.child_folders.is_empty());

        let x = tree.get(x_id);
        assert_eq!(x.depth, 1);
        assert_eq!(x.parent, Some(0));
        assert_eq!(x.transitive_size, 1);
        assert_eq!(x.direct_leaves, vec![2]);
    }

    #[test]
    fn deeply_nested_path_creates_intermediate_folders() {
        let inputs = [(0, "a/b/c/d.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        assert_eq!(tree.len(), 4, "expected ., a, a/b, a/b/c");
        assert_eq!(tree.get(0).depth, 0);
        assert_eq!(tree.get(tree.folder_id("a").unwrap()).depth, 1);
        assert_eq!(tree.get(tree.folder_id("a/b").unwrap()).depth, 2);
        assert_eq!(tree.get(tree.folder_id("a/b/c").unwrap()).depth, 3);
        assert_eq!(tree.max_depth(), 3);
        // transitive sizes accumulate up.
        assert_eq!(tree.get(tree.folder_id("a/b/c").unwrap()).transitive_size, 1);
        assert_eq!(tree.get(tree.folder_id("a/b").unwrap()).transitive_size, 1);
        assert_eq!(tree.get(tree.folder_id("a").unwrap()).transitive_size, 1);
        assert_eq!(tree.get(tree.root()).transitive_size, 1);

        let leaf = tree.get(tree.folder_id("a/b/c").unwrap());
        assert_eq!(leaf.direct_leaves, vec![0]);
    }

    #[test]
    fn determinism_same_input_same_tree_bytes() {
        // Random-ish leaf order to guard against accidental dependency on insert order.
        let inputs = [
            (5, "x/y/z/leaf.rs"),
            (1, "a/b.rs"),
            (3, "a/b/c.rs"),
            (4, "x/y/leaf2.rs"),
            (2, "a/c.rs"),
            (6, "top.md"),
        ];
        let t1 = FolderTree::build_from_paths(&inputs);
        let t2 = FolderTree::build_from_paths(&inputs);

        assert_eq!(t1.len(), t2.len(), "folder count differs");
        for i in 0..t1.len() {
            let a = &t1.folders[i];
            let b = &t2.folders[i];
            assert_eq!(a.path, b.path, "path mismatch at index {}", i);
            assert_eq!(a.depth, b.depth);
            assert_eq!(a.parent, b.parent);
            assert_eq!(a.child_folders, b.child_folders);
            assert_eq!(a.direct_leaves, b.direct_leaves);
            assert_eq!(a.transitive_size, b.transitive_size);
        }
    }

    #[test]
    fn iter_visits_every_folder_exactly_once() {
        let inputs = [(0, "a/x.rs"), (1, "a/b/y.rs")];
        let tree = FolderTree::build_from_paths(&inputs);
        let collected: Vec<(FolderId, String)> =
            tree.iter().map(|(id, f)| (id, f.path.clone())).collect();
        assert_eq!(collected.len(), tree.len());
        let mut paths: Vec<&str> = collected.iter().map(|(_, p)| p.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec![".", "a", "a/b"]);
    }

    #[test]
    fn folder_id_lookup_returns_none_for_missing_path() {
        let tree = FolderTree::build_from_paths(&[(0, "a/b.rs")]);
        assert!(tree.folder_id("does/not/exist").is_none());
        assert!(tree.folder_id("a").is_some());
        assert_eq!(tree.folder_id(".").unwrap(), tree.root());
    }

    #[test]
    fn node_to_folder_maps_every_leaf_to_its_folder() {
        // Mixed: two leaves in "a", one in "x", one at root.
        let inputs = [(0u32, "a/x.rs"), (1u32, "a/y.rs"), (2u32, "x/z.rs"), (3u32, "top.md")];
        let tree = FolderTree::build_from_paths(&inputs);
        let mapping = tree.node_to_folder(4);

        let a_id = tree.folder_id("a").unwrap();
        let x_id = tree.folder_id("x").unwrap();
        let root_id = tree.root();

        assert_eq!(mapping[0], a_id);
        assert_eq!(mapping[1], a_id);
        assert_eq!(mapping[2], x_id);
        assert_eq!(mapping[3], root_id);
    }

    #[test]
    fn build_from_paths_with_leaves_handles_slash_in_leaf_id() {
        // Grafema V2 semantic IDs may contain `/` (e.g. "pkg/path->FUNCTION->foo").
        // The opaque leaf_id must survive intact — we must NOT split it into
        // folders. Folders come solely from folder_path.
        let id_with_slash = "packages/util/src/index.ts->FUNCTION->foo";
        let pairs: &[(NodeIdx, &str, &str)] = &[
            (0, "packages/util/src", id_with_slash),
            (1, "packages/util/src", "packages/util/src/index.ts->FUNCTION->bar"),
        ];
        let tree = FolderTree::build_from_paths_with_leaves(pairs);

        // Folders: . + packages + packages/util + packages/util/src.
        assert_eq!(tree.len(), 4);
        let src = tree.get(tree.folder_id("packages/util/src").unwrap());
        // Both leaves placed in that single folder — leaf_id was not split.
        assert_eq!(src.direct_leaves.len(), 2);
    }

    #[test]
    fn build_from_paths_with_leaves_dedupes_duplicate_leaf_ids_with_warn() {
        // Two triples sharing the same leaf_id → only the first survives.
        let pairs: &[(NodeIdx, &str, &str)] = &[
            (0, "a", "same-id"),
            (1, "a", "same-id"),
            (2, "a", "different-id"),
        ];
        let tree = FolderTree::build_from_paths_with_leaves(pairs);
        let a = tree.get(tree.folder_id("a").unwrap());
        // Only NodeIdx 0 and 2 should land; 1 dedup'd out.
        assert_eq!(a.direct_leaves.len(), 2);
        assert!(a.direct_leaves.contains(&0));
        assert!(a.direct_leaves.contains(&2));
        assert!(!a.direct_leaves.contains(&1));
    }

    #[test]
    fn build_from_paths_with_leaves_empty_folder_path_is_root() {
        let pairs: &[(NodeIdx, &str, &str)] = &[
            (0, ".", "leaf-a"),
            (1, "", "leaf-b"),
        ];
        let tree = FolderTree::build_from_paths_with_leaves(pairs);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree.get(tree.root()).direct_leaves.len(), 2);
    }

    #[test]
    fn node_to_folder_unmapped_indices_get_sentinel() {
        // 1 leaf, but ask for 3 slots — slots 1 and 2 should keep the sentinel.
        let tree = FolderTree::build_from_paths(&[(0u32, "a/x.rs")]);
        let mapping = tree.node_to_folder(3);
        assert_eq!(mapping[0], tree.folder_id("a").unwrap());
        assert_eq!(mapping[1], FolderId::MAX, "unassigned slot must hold sentinel");
        assert_eq!(mapping[2], FolderId::MAX);
    }
}
