//! Hex-grid layout engine — Rust port of `sandbox/hex-sandbox/src/pack.js`.
//!
//! Builds a hierarchical hex map from a folder-tree of code symbols. Phase
//! files are independently unit-testable so the algorithm can be reviewed
//! piecewise (foundations → pack → iswap → xswap → validate).
//!
//! This module currently exposes the foundation layer (Step 1 of REG-1102),
//! the recursive folder packer + topology validator (Step 2), the
//! intra-folder permutation optimiser (Step 3), the cross-folder boundary
//! swap with connectivity-preserving BFS (Step 4), the synthetic-input
//! end-to-end driver + JSON dumper exposed by the CLI (Step 5), the
//! RFDB-backed input loader (Step 6), and the RFDB commit step that writes
//! `LAYOUT_POSITION` edges back (Step 8).

pub mod commit;
pub mod edges;
pub mod hex;
pub mod iswap;
pub mod json_dump;
pub mod loader;
pub mod pack;
pub mod runner;
pub mod state;
pub mod synthetic;
pub mod tree;
pub mod validate;
pub mod xswap;

pub use commit::{
    build_commit_payload, build_layout_position_edges, build_region_graph,
    build_region_to_symbol_edges, commit_layout, region_semantic_id, url_encode_region_path,
    CommitPayload, FileOverflow, HardCapOutcome, PlacedSymbol, DEFAULT_HARD_CAP,
};
pub use edges::{Edge, Incidence};
pub use hex::{pack_key, unpack_key, HexCoord, HEX_DIRS};
pub use iswap::iswap;
pub use json_dump::dump_to_writer;
pub use loader::load_from_rfdb;
pub use pack::{pack, pack_folder};
pub use runner::{run_layout, LayoutStats, RunOpts, RunResult};
pub use state::{NodeIdx, PlacementState};
pub use synthetic::{generate, LayoutInput};
pub use tree::{Folder, FolderId, FolderTree};
pub use validate::{validate, TornFolder, ValidationReport};
pub use xswap::xswap;
