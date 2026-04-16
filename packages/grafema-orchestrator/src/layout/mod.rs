//! Hex-grid layout engine — Rust port of `sandbox/hex-sandbox/src/pack.js`.
//!
//! Builds a hierarchical hex map from a folder-tree of code symbols. Phase
//! files are independently unit-testable so the algorithm can be reviewed
//! piecewise (foundations → pack → iswap → xswap → validate).
//!
//! This module currently exposes the foundation layer (Step 1 of REG-1102) plus
//! the recursive folder packer + topology validator (Step 2). Subsequent steps
//! add `iswap.rs`, `xswap.rs`, and `loader.rs`.

pub mod hex;
pub mod pack;
pub mod state;
pub mod tree;
pub mod validate;

pub use hex::HexCoord;
pub use pack::{pack, pack_folder};
pub use state::{NodeIdx, PlacementState};
pub use tree::{Folder, FolderId, FolderTree};
pub use validate::{validate, TornFolder, ValidationReport};
