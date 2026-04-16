//! Hex-grid layout engine — Rust port of `sandbox/hex-sandbox/src/pack.js`.
//!
//! Builds a hierarchical hex map from a folder-tree of code symbols. Phase
//! files are independently unit-testable so the algorithm can be reviewed
//! piecewise (foundations → pack → iswap → xswap → validate).
//!
//! This module currently exposes the foundation layer (Step 1 of REG-1102),
//! the recursive folder packer + topology validator (Step 2), the
//! intra-folder permutation optimiser (Step 3), and the cross-folder
//! boundary swap with connectivity-preserving BFS (Step 4). The remaining
//! step adds `loader.rs`.

pub mod edges;
pub mod hex;
pub mod iswap;
pub mod pack;
pub mod state;
pub mod tree;
pub mod validate;
pub mod xswap;

pub use edges::{Edge, Incidence};
pub use hex::HexCoord;
pub use iswap::iswap;
pub use pack::{pack, pack_folder};
pub use state::{NodeIdx, PlacementState};
pub use tree::{Folder, FolderId, FolderTree};
pub use validate::{validate, TornFolder, ValidationReport};
pub use xswap::xswap;
