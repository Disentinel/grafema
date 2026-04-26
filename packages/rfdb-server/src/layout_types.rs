//! Node-type classification for the layout consumer (DAI-22 Chunk-4).
//!
//! Mirrors the producer's placeable-type list so the stream emitter can
//! tag each node with the right `unplaced_reason` without a crate-level
//! dependency on `grafema-orchestrator`. A node whose type is NOT in this
//! list is classified as `"excluded"` (the GUI silently hides it). Nodes
//! whose type IS in the list but which have no LAYOUT_POSITION entry get
//! `"missing_layout"` (when the whole layout is absent) or
//! `"skipped_overflow"` (when the layout exists but this symbol was
//! dropped by the per-file hard-cap).
//
// Mirror of grafema-orchestrator/src/layout/loader.rs PLACEABLE_TYPES — keep in sync.

/// Node types that the orchestrator's layout-pack treats as placeable (one
/// tile per symbol). A node of any other type is "excluded" from the map.
pub const PLACEABLE_TYPES: &[&str] = &[
    // NOTE: `MODULE` and `SERVICE` were here historically (one tile per
    // file). They cluttered the per-tile LOD with redundant container
    // hexes — the file's region/hull already represents it visually,
    // and the GUI was silently filtering them via a legacy
    // `EXCLUDED_TYPES` set. Drop them server-side so the wire ships
    // them in the excluded batch instead. To re-enable, add them back
    // here AND remove the `EXCLUDED_TYPES` filter in
    // `packages/gui/src/store/loadStream.ts`.
    "FUNCTION",
    "METHOD",
    "CLASS",
    "VARIABLE",
    "CONSTANT",
    "INTERFACE",
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
];

/// Cheap membership test. Keeps the callsite branch-free-ish for the hot
/// stream emission loop.
pub fn is_placeable(node_type: &str) -> bool {
    PLACEABLE_TYPES.iter().any(|t| *t == node_type)
}
