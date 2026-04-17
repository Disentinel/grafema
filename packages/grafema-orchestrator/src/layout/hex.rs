//! Axial hex coordinate primitives for the layout engine.
//!
//! Mirrors the FLAT-TOP convention from `sandbox/hex-sandbox/src/hex.js`:
//! `+q` = east, `+r` = south-east, `s = -q - r` is the third cube axis.
//! `HEX_DIRS` order matches the JS reference exactly (E, NE, NW, W, SW, SE).
//!
//! ABI-compatible with `packages/rfdb-server/src/sa_layout.rs:20-35` but kept
//! local to avoid a heavy cross-crate dependency for a 15-line struct.

/// Axial hex coordinate. `s` (third cube axis) is implicit: `s = -q - r`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HexCoord {
    /// East-axis coordinate.
    pub q: i32,
    /// South-east-axis coordinate.
    pub r: i32,
}

impl HexCoord {
    /// Construct a coord from raw `(q, r)`.
    pub fn new(q: i32, r: i32) -> Self {
        Self { q, r }
    }

    /// Cube distance to another coord (number of hex steps along the shortest path).
    pub fn distance(self, other: Self) -> i32 {
        let dq = (self.q - other.q).abs();
        let dr = (self.r - other.r).abs();
        // ds in cube space is -(dq+dr); abs is the same magnitude.
        let ds = ((self.q + self.r) - (other.q + other.r)).abs();
        dq.max(dr).max(ds)
    }
}

/// Six neighbour offsets in axial coords, FLAT-TOP convention.
/// Order matches `sandbox/hex-sandbox/src/hex.js`: E, NE, NW, W, SW, SE.
pub const HEX_DIRS: [HexCoord; 6] = [
    HexCoord { q: 1, r: 0 },   // E
    HexCoord { q: 1, r: -1 },  // NE
    HexCoord { q: 0, r: -1 },  // NW
    HexCoord { q: -1, r: 0 },  // W
    HexCoord { q: -1, r: 1 },  // SW
    HexCoord { q: 0, r: 1 },   // SE
];

/// Pack `(q, r)` into a single `i64` for use as a hash-map key.
///
/// Avoids the JS `"q,r"` string allocation. Uniquely encodes any pair of
/// `i32` values: high 32 bits hold `q`, low 32 bits hold `r` (zero-extended
/// from the i32 bit pattern, so negative `r` packs as its two's-complement
/// bit pattern in the lower half).
#[inline]
pub fn pack_key(q: i32, r: i32) -> i64 {
    ((q as i64) << 32) | ((r as i64) & 0xFFFF_FFFF)
}

/// Inverse of [`pack_key`] — primarily for tests and debug output.
#[inline]
pub fn unpack_key(key: i64) -> (i32, i32) {
    let q = (key >> 32) as i32;
    let r = (key & 0xFFFF_FFFF) as u32 as i32;
    (q, r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_origin_to_east_is_one() {
        let origin = HexCoord::new(0, 0);
        let east = HEX_DIRS[0];
        assert_eq!(origin.distance(east), 1);
    }

    #[test]
    fn distance_east_to_west_is_two() {
        let east = HEX_DIRS[0];
        let west = HEX_DIRS[3];
        assert_eq!(east.distance(west), 2);
    }

    #[test]
    fn distance_two_steps_northeast() {
        let origin = HexCoord::new(0, 0);
        let ne = HEX_DIRS[1];
        let two_ne = HexCoord::new(ne.q * 2, ne.r * 2);
        assert_eq!(origin.distance(two_ne), 2);
    }

    #[test]
    fn distance_is_symmetric() {
        let a = HexCoord::new(3, -2);
        let b = HexCoord::new(-1, 4);
        assert_eq!(a.distance(b), b.distance(a));
    }

    #[test]
    fn hex_dirs_all_have_distance_one_from_origin() {
        let origin = HexCoord::new(0, 0);
        for d in HEX_DIRS.iter() {
            assert_eq!(origin.distance(*d), 1, "dir {:?} not adjacent to origin", d);
        }
    }

    #[test]
    fn pack_unpack_roundtrip_simple() {
        for &(q, r) in &[(0, 0), (1, 2), (-3, 4), (-100, -200), (i32::MAX, i32::MIN)] {
            let key = pack_key(q, r);
            assert_eq!(unpack_key(key), (q, r), "roundtrip failed for ({}, {})", q, r);
        }
    }

    #[test]
    fn pack_keys_are_unique_for_distinct_inputs() {
        let mut seen = std::collections::HashSet::new();
        for q in -10..=10 {
            for r in -10..=10 {
                let key = pack_key(q, r);
                assert!(seen.insert(key), "duplicate key for ({}, {})", q, r);
            }
        }
    }

    #[test]
    fn pack_unpack_property_random_sample() {
        // Deterministic pseudo-random sample (no rng dep needed).
        let mut state: u64 = 0xDEAD_BEEF_CAFE_F00D;
        for _ in 0..256 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let q = (state >> 32) as i32;
            let r = state as i32;
            assert_eq!(unpack_key(pack_key(q, r)), (q, r));
        }
    }
}
