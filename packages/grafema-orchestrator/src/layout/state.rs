//! Placement state — occupancy map keyed by packed `i64` hex coords.
//!
//! Equivalent to the `createState()` closure in `sandbox/hex-sandbox/src/pack.js`,
//! plus a BFS spiral fallback (`spiral_empty`) used when a folder's local
//! neighbourhood is fully saturated by siblings.

use rustc_hash::FxHashMap;

use super::hex::{pack_key, HexCoord};

/// Stable index into the contiguous `Vec<NodeRef>` owned by `LayoutInput`.
///
/// File-local typedef; `mod.rs` re-exports it as `layout::NodeIdx` so the rest
/// of the crate can refer to a single canonical name.
pub type NodeIdx = u32;

/// Tracks which cells are occupied and by which node.
pub struct PlacementState {
    occupied: FxHashMap<i64, NodeIdx>,
}

impl Default for PlacementState {
    fn default() -> Self {
        Self::new()
    }
}

impl PlacementState {
    /// Construct an empty state.
    pub fn new() -> Self {
        Self { occupied: FxHashMap::default() }
    }

    /// Place `node` at `coord`. Returns `Err` if a node is already there.
    pub fn place(&mut self, node: NodeIdx, coord: HexCoord) -> Result<(), String> {
        let key = pack_key(coord.q, coord.r);
        if let Some(existing) = self.occupied.get(&key) {
            return Err(format!(
                "pack: double-place at ({}, {}): {} would overwrite {}",
                coord.q, coord.r, node, existing
            ));
        }
        self.occupied.insert(key, node);
        Ok(())
    }

    /// Whether the cell at `(q, r)` is currently empty.
    pub fn is_empty(&self, q: i32, r: i32) -> bool {
        !self.occupied.contains_key(&pack_key(q, r))
    }

    /// Look up the occupant of `(q, r)`, if any.
    pub fn get(&self, q: i32, r: i32) -> Option<NodeIdx> {
        self.occupied.get(&pack_key(q, r)).copied()
    }

    /// Number of placed nodes.
    pub fn len(&self) -> usize {
        self.occupied.len()
    }

    /// Whether no nodes have been placed.
    pub fn is_state_empty(&self) -> bool {
        self.occupied.is_empty()
    }

    /// BFS spiral outward from `center`, returning the first empty cell.
    ///
    /// Mirrors `spiralEmpty` in `pack.js:168-180`. Returns `None` if no empty
    /// cell is found within `max_ring` rings (the JS reference uses 10000
    /// and throws on miss; we let callers decide via `Option`).
    pub fn spiral_empty(&self, center: HexCoord, max_ring: u32) -> Option<HexCoord> {
        for ring in 0..=max_ring as i32 {
            for dq in -ring..=ring {
                for dr in -ring..=ring {
                    // cube-distance == ring filter (only iterate the ring's hull)
                    let dist = dq.abs().max(dr.abs()).max((dq + dr).abs());
                    if dist != ring {
                        continue;
                    }
                    let q = center.q + dq;
                    let r = center.r + dr;
                    if self.is_empty(q, r) {
                        return Some(HexCoord::new(q, r));
                    }
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::hex::HEX_DIRS;
    use super::*;

    #[test]
    fn new_state_is_empty() {
        let s = PlacementState::new();
        assert_eq!(s.len(), 0);
        assert!(s.is_state_empty());
        assert!(s.is_empty(0, 0));
        assert_eq!(s.get(0, 0), None);
    }

    #[test]
    fn place_then_query() {
        let mut s = PlacementState::new();
        s.place(7, HexCoord::new(2, -1)).unwrap();
        assert_eq!(s.len(), 1);
        assert!(!s.is_empty(2, -1));
        assert_eq!(s.get(2, -1), Some(7));
        // Other cells still empty.
        assert!(s.is_empty(0, 0));
    }

    #[test]
    fn double_place_errors() {
        let mut s = PlacementState::new();
        s.place(1, HexCoord::new(0, 0)).unwrap();
        let err = s.place(2, HexCoord::new(0, 0)).unwrap_err();
        assert!(err.contains("double-place"), "unexpected error: {}", err);
        // Original placement preserved.
        assert_eq!(s.get(0, 0), Some(1));
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn spiral_empty_returns_center_when_empty() {
        let s = PlacementState::new();
        let found = s.spiral_empty(HexCoord::new(3, 4), 5).unwrap();
        assert_eq!(found, HexCoord::new(3, 4));
    }

    #[test]
    fn spiral_empty_finds_adjacent_when_center_occupied() {
        let mut s = PlacementState::new();
        let center = HexCoord::new(0, 0);
        s.place(0, center).unwrap();
        let found = s.spiral_empty(center, 5).unwrap();
        // Must be one of the six neighbours (ring 1).
        assert_eq!(center.distance(found), 1, "found cell {:?} not on ring 1", found);
    }

    #[test]
    fn spiral_empty_handles_ring2_when_ring1_full() {
        let mut s = PlacementState::new();
        let center = HexCoord::new(0, 0);
        s.place(0, center).unwrap();
        for (i, d) in HEX_DIRS.iter().enumerate() {
            s.place((i as u32) + 1, *d).unwrap();
        }
        let found = s.spiral_empty(center, 5).unwrap();
        assert_eq!(center.distance(found), 2, "expected ring-2 cell, got {:?}", found);
    }

    #[test]
    fn spiral_empty_returns_none_when_nothing_within_max_ring() {
        // Saturate ring 0 only and ask for max_ring=0 — must return None.
        let mut s = PlacementState::new();
        let center = HexCoord::new(0, 0);
        s.place(0, center).unwrap();
        assert_eq!(s.spiral_empty(center, 0), None);
    }
}
