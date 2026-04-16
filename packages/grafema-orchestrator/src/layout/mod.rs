//! Hex-grid layout engine — Rust port of `sandbox/hex-sandbox/src/pack.js`.
//!
//! Builds a hierarchical hex map from a folder-tree of code symbols. Phase
//! files are independently unit-testable so the algorithm can be reviewed
//! piecewise (foundations → pack → iswap → xswap → validate).
//!
//! This module currently exposes only the foundation layer (Step 1 of REG-1102):
//! hex math, occupancy state, and folder-tree construction. Subsequent steps
//! add `pack.rs`, `iswap.rs`, `xswap.rs`, `validate.rs`, and `loader.rs`.

pub mod hex;
pub mod state;
pub mod tree;

pub use hex::HexCoord;
pub use state::{NodeIdx, PlacementState};
pub use tree::{Folder, FolderId, FolderTree};
