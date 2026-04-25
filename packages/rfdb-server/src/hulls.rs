//! Per-region hull computation — Rust port of
//! `packages/gui/src/geom/hull.ts` (boundary trace) and
//! `packages/gui/src/hulls/computeHulls.ts` (morph-close + flood-fill +
//! descendant aggregation).
//!
//! Used by `http_server` to ship pre-computed hull polygons in the
//! initial `hulls` frame of `/api/graph-stream`, so the GUI can render
//! the map outline before the node tail arrives.
//!
//! Parity invariant: the algorithms must produce the same polygon loops
//! the TS implementations would, given identical placed positions and
//! the same `hex_size`. The integration test
//! `tests/hulls_parity.rs` will lock that contract by comparing
//! against a captured TS snapshot on the grafema repo.
//!
//! Numerics: coordinates are emitted as `f32`. The TS algorithm uses
//! `f64` internally but quantises to 1/1000 px when looking up corner
//! identity, so `f32` precision (≈ 7 decimal digits) is more than
//! enough for the corner-key match. See `corner_key` below.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::sa_layout::HexCoord;

/// Six axial-coord neighbour offsets, clockwise from East. Order MUST
/// match `packages/gui/src/geom/hex.mjs::HEX_DIRS` so `EDGE_TO_DIR`
/// addresses the correct neighbour for each edge.
pub const HEX_DIRS: [(i32, i32); 6] = [
    (1, 0),   // E
    (1, -1),  // NE
    (0, -1),  // NW
    (-1, 0),  // W
    (-1, 1),  // SW
    (0, 1),   // SE
];

/// Edge index (0..5, CCW from east) → HEX_DIRS index. Lifted verbatim
/// from `packages/gui/src/geom/hull.ts:EDGE_TO_DIR`.
const EDGE_TO_DIR: [usize; 6] = [0, 5, 4, 3, 2, 1];

/// Hex radius (centre → corner) used by the GUI's HexLayer. Mirrors
/// `packages/gui/src/hooks/canvasBuild.ts::TILE_SIZE = 3.0`. Polygons
/// emitted at this size land in the same world frame the GUI renders
/// hexes in — no client-side rescaling needed.
pub const TILE_SIZE: f32 = 3.0;

/// Pixel-space (x, y) point on a polygon. JSON-serialised as `[x, y]`
/// when emitted via the wire frame — see `Polygon::to_json_pairs`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Point2 {
    pub x: f32,
    pub y: f32,
}

/// One closed polygon loop. First vertex is repeated at the end.
pub type Polygon = Vec<Point2>;

/// Region hull: zero or more closed polygons (concave shapes / holes
/// emit one outer + zero-or-more inner; disjoint islands emit several).
#[derive(Debug, Clone, Default, Serialize)]
pub struct RegionHull {
    pub polygons: Vec<Polygon>,
    /// Number of hex cells in the closed set after morph-close +
    /// hole-fill. Used by GUI for label-size scaling.
    pub area: usize,
}

/// Axial → pixel (x, y), flat-top hex.
///
/// Mirrors `packages/gui/src/geom/hex.mjs::axialToPixel` — same
/// coefficients (`size * 1.5 * q`, `size * sqrt(3) * (r + q/2)`).
fn axial_to_pixel(q: i32, r: i32, size: f32) -> Point2 {
    let qf = q as f32;
    let rf = r as f32;
    Point2 {
        x: size * 1.5 * qf,
        y: size * 3f32.sqrt() * (rf + qf * 0.5),
    }
}

/// Stable string key for a corner — quantises to 1/1000 px so two hex
/// tiles that nominally share a corner hash to the same bucket despite
/// any float rounding drift in the `axial_to_pixel` chain.
fn corner_key(p: Point2) -> u64 {
    // Pack two i32 quantised coords into one u64 so we can use `HashMap`
    // without an extra allocation per corner. Quantisation: round to
    // 1/1000 px (matches TS's `Math.round(p * 1000)`).
    let xi = (p.x * 1000.0).round() as i32 as u32;
    let yi = (p.y * 1000.0).round() as i32 as u32;
    ((xi as u64) << 32) | (yi as u64)
}

fn same_point(a: Point2, b: Point2) -> bool {
    (a.x - b.x).abs() < 0.005 && (a.y - b.y).abs() < 0.005
}

/// Trace the outer boundary of a hex tile set as one or more closed
/// polygon loops in pixel coordinates. Port of
/// `packages/gui/src/geom/hull.ts::computeHullPolygons`.
///
/// - Concave shapes / holes emit multiple loops.
/// - Returns empty when `tiles` is empty.
/// - Loops with fewer than 4 vertices (a degenerate single-edge case)
///   are dropped, matching the TS implementation.
pub fn compute_hull_polygons(tiles: &HashSet<HexCoord>, size: f32) -> Vec<Polygon> {
    if tiles.is_empty() {
        return Vec::new();
    }

    // Precompute the 6 corner offsets for a flat-top hex.
    let mut corners: [Point2; 6] = [Point2 { x: 0.0, y: 0.0 }; 6];
    for i in 0..6 {
        let a = std::f32::consts::PI / 3.0 * i as f32;
        corners[i] = Point2 {
            x: size * a.cos(),
            y: size * a.sin(),
        };
    }

    // ── Collect boundary edges ────────────────────────────────────
    let mut edges: Vec<(Point2, Point2)> = Vec::new();
    // Sort tile iteration for determinism — HashSet order is
    // non-deterministic across runs, which would produce different
    // (but topologically equivalent) loops; tests assume stable
    // output.
    let mut tile_list: Vec<HexCoord> = tiles.iter().copied().collect();
    tile_list.sort_by(|a, b| a.q.cmp(&b.q).then(a.r.cmp(&b.r)));

    for t in &tile_list {
        let center = axial_to_pixel(t.q, t.r, size);
        for ei in 0..6 {
            let (dq, dr) = HEX_DIRS[EDGE_TO_DIR[ei]];
            let neigh = HexCoord { q: t.q + dq, r: t.r + dr };
            if tiles.contains(&neigh) {
                continue;
            }
            let a = Point2 {
                x: center.x + corners[ei].x,
                y: center.y + corners[ei].y,
            };
            let b = Point2 {
                x: center.x + corners[(ei + 1) % 6].x,
                y: center.y + corners[(ei + 1) % 6].y,
            };
            edges.push((a, b));
        }
    }
    if edges.is_empty() {
        return Vec::new();
    }

    // ── Corner → edge-index lookup ────────────────────────────────
    let mut by_corner: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, (a, b)) in edges.iter().enumerate() {
        by_corner.entry(corner_key(*a)).or_default().push(i);
        by_corner.entry(corner_key(*b)).or_default().push(i);
    }

    // ── Walk loops ────────────────────────────────────────────────
    let mut used = vec![false; edges.len()];
    let mut loops: Vec<Polygon> = Vec::new();
    let safety_cap = edges.len() * 4 + 8;

    for start in 0..edges.len() {
        if used[start] {
            continue;
        }
        let mut loop_pts: Polygon = Vec::new();
        let mut cur_idx = start;
        let mut cur_edge = edges[cur_idx];
        let mut cur_point = cur_edge.0;
        loop_pts.push(cur_point);
        used[cur_idx] = true;

        let mut safety = safety_cap;
        while safety > 0 {
            safety -= 1;
            let other = if same_point(cur_point, cur_edge.0) {
                cur_edge.1
            } else {
                cur_edge.0
            };
            loop_pts.push(other);

            if same_point(other, loop_pts[0]) {
                break;
            }

            let neigh = match by_corner.get(&corner_key(other)) {
                Some(v) => v,
                None => break,
            };
            let mut next_idx: i64 = -1;
            for &ni in neigh {
                if ni == cur_idx {
                    continue;
                }
                if used[ni] {
                    continue;
                }
                next_idx = ni as i64;
                break;
            }
            if next_idx < 0 {
                break;
            }
            let ni = next_idx as usize;
            used[ni] = true;
            cur_idx = ni;
            cur_edge = edges[ni];
            cur_point = other;
        }

        if loop_pts.len() >= 4 {
            loops.push(loop_pts);
        }
    }

    loops
}

/// Dilate a hex cell set: add every 6-neighbour of every member.
fn dilate(cells: &HashSet<HexCoord>) -> HashSet<HexCoord> {
    let mut out = cells.clone();
    for c in cells {
        for (dq, dr) in HEX_DIRS {
            out.insert(HexCoord { q: c.q + dq, r: c.r + dr });
        }
    }
    out
}

/// Erode a hex cell set: keep only cells whose 6 neighbours are all in
/// the input set. Cells without all neighbours present are dropped.
fn erode(cells: &HashSet<HexCoord>) -> HashSet<HexCoord> {
    let mut out = HashSet::new();
    for c in cells {
        let mut all_in = true;
        for (dq, dr) in HEX_DIRS {
            if !cells.contains(&HexCoord { q: c.q + dq, r: c.r + dr }) {
                all_in = false;
                break;
            }
        }
        if all_in {
            out.insert(*c);
        }
    }
    out
}

/// Morphological close at radius `r`: dilate r times, then erode r
/// times. Net effect: ≤r-cell interior gaps fill in, exterior shape is
/// preserved (modulo a 1-cell smoothing per radius).
pub fn morphological_close(cells: &HashSet<HexCoord>, radius: u32) -> HashSet<HexCoord> {
    if radius == 0 {
        return cells.clone();
    }
    let mut current = cells.clone();
    for _ in 0..radius {
        current = dilate(&current);
    }
    for _ in 0..radius {
        current = erode(&current);
    }
    current
}

/// Drop interior holes by flood-filling exterior space from outside
/// the bounding box; anything not reached and not already in `cells`
/// is a hole and gets added.
pub fn fill_holes(cells: &HashSet<HexCoord>) -> HashSet<HexCoord> {
    if cells.is_empty() {
        return cells.clone();
    }
    // Bounding box with one-cell margin so the flood seed sits guaranteed
    // outside any island.
    let (mut min_q, mut max_q, mut min_r, mut max_r) = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
    for c in cells {
        min_q = min_q.min(c.q);
        max_q = max_q.max(c.q);
        min_r = min_r.min(c.r);
        max_r = max_r.max(c.r);
    }
    let lo_q = min_q - 1;
    let hi_q = max_q + 1;
    let lo_r = min_r - 1;
    let hi_r = max_r + 1;

    let mut visited: HashSet<HexCoord> = HashSet::new();
    let mut queue: VecDeque<HexCoord> = VecDeque::new();
    let seed = HexCoord { q: lo_q, r: lo_r };
    visited.insert(seed);
    queue.push_back(seed);

    while let Some(c) = queue.pop_front() {
        for (dq, dr) in HEX_DIRS {
            let n = HexCoord { q: c.q + dq, r: c.r + dr };
            if n.q < lo_q || n.q > hi_q || n.r < lo_r || n.r > hi_r {
                continue;
            }
            if visited.contains(&n) || cells.contains(&n) {
                continue;
            }
            visited.insert(n);
            queue.push_back(n);
        }
    }

    let mut out = cells.clone();
    for q in lo_q..=hi_q {
        for r in lo_r..=hi_r {
            let c = HexCoord { q, r };
            if !visited.contains(&c) && !cells.contains(&c) {
                out.insert(c);
            }
        }
    }
    out
}

/// Run morph-close + hole-fill + boundary trace for one region's tile
/// set. Convenience wrapper used by both production code and tests.
pub fn region_hull(tiles: &HashSet<HexCoord>, hex_size: f32, radius: u32) -> RegionHull {
    let closed = morphological_close(tiles, radius);
    let filled = fill_holes(&closed);
    let polygons = compute_hull_polygons(&filled, hex_size);
    RegionHull { polygons, area: filled.len() }
}

/// Aggregate placed cells for one region, recursively descending into
/// child REGION ids.
///
/// `containment[region_id]` may contain both child REGION ids (folder
/// tree) and SYMBOL ids (leaf attachments). `positions` resolves SYMBOL
/// ids to placed `HexCoord`s; symbols missing from `positions`
/// (overflow-skipped) are silently dropped — they don't contribute to
/// the hull and the GUI surfaces them via a separate badge layer.
fn collect_member_cells(
    region_id: u128,
    containment: &HashMap<u128, Vec<u128>>,
    positions: &HashMap<u128, HexCoord>,
    region_ids: &HashSet<u128>,
) -> HashSet<HexCoord> {
    let mut out: HashSet<HexCoord> = HashSet::new();
    let mut stack: Vec<u128> = vec![region_id];
    let mut seen: HashSet<u128> = HashSet::new();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        if let Some(children) = containment.get(&id) {
            for &child in children {
                if region_ids.contains(&child) {
                    stack.push(child);
                } else if let Some(pos) = positions.get(&child) {
                    out.insert(*pos);
                }
            }
        }
    }
    out
}

/// Compute hulls for every region with at least one placed descendant.
/// `hex_size`, `morph_radius` mirror the TS defaults
/// (`TILE_SIZE = 3.0`, `radius = 1`).
///
/// Returns `region_id → RegionHull`. Regions with zero placed
/// descendants are absent from the map (caller's `.get()` returns
/// None — same semantic as the TS `Map.get()`).
pub fn compute_hulls_for_regions(
    region_ids: &HashSet<u128>,
    containment: &HashMap<u128, Vec<u128>>,
    positions: &HashMap<u128, HexCoord>,
    hex_size: f32,
    morph_radius: u32,
) -> HashMap<u128, RegionHull> {
    let mut out = HashMap::with_capacity(region_ids.len());
    for &rid in region_ids {
        let cells = collect_member_cells(rid, containment, positions, region_ids);
        if cells.is_empty() {
            continue;
        }
        let hull = region_hull(&cells, hex_size, morph_radius);
        if hull.polygons.is_empty() {
            continue;
        }
        out.insert(rid, hull);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_of(items: &[(i32, i32)]) -> HashSet<HexCoord> {
        items.iter().map(|&(q, r)| HexCoord { q, r }).collect()
    }

    #[test]
    fn single_hex_emits_one_loop_with_six_corners() {
        // A lone hex is its own boundary — six edges, one closed loop
        // of seven vertices (first repeated).
        let tiles = set_of(&[(0, 0)]);
        let polys = compute_hull_polygons(&tiles, 1.0);
        assert_eq!(polys.len(), 1, "got {} loops, want 1", polys.len());
        assert_eq!(polys[0].len(), 7, "loop should be 6 corners + closing repeat");
    }

    #[test]
    fn empty_tiles_produces_no_polygons() {
        let polys = compute_hull_polygons(&HashSet::new(), 1.0);
        assert!(polys.is_empty());
    }

    #[test]
    fn two_adjacent_hexes_share_an_edge_so_one_outer_loop() {
        // Two cells sharing the eastern edge — outline has 10 vertices
        // (12 corners minus the 2 internal ones, plus closing repeat).
        let tiles = set_of(&[(0, 0), (1, 0)]);
        let polys = compute_hull_polygons(&tiles, 1.0);
        assert_eq!(polys.len(), 1);
        // 10 edges around the two-hex shape -> 11 vertices when closed.
        assert_eq!(polys[0].len(), 11, "two-hex outline should be 10 corners + close");
    }

    #[test]
    fn disjoint_islands_emit_separate_loops() {
        // Two cells far apart (gap > 1) -> two independent boundary loops.
        let tiles = set_of(&[(0, 0), (10, 10)]);
        let polys = compute_hull_polygons(&tiles, 1.0);
        assert_eq!(polys.len(), 2, "got {} loops, want 2", polys.len());
    }

    #[test]
    fn morph_close_radius_1_fills_one_cell_pinhole() {
        // Six neighbours around an empty centre — radius-1 close should
        // fill the hole.
        let ring = set_of(&[
            (1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1),
        ]);
        let closed = morphological_close(&ring, 1);
        assert!(
            closed.contains(&HexCoord { q: 0, r: 0 }),
            "pinhole at origin should be filled by morph-close",
        );
    }

    #[test]
    fn fill_holes_drops_interior_voids() {
        // Same ring, no morph close — fill_holes should still close the
        // void independently.
        let ring = set_of(&[
            (1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1),
        ]);
        let filled = fill_holes(&ring);
        assert!(
            filled.contains(&HexCoord { q: 0, r: 0 }),
            "fill_holes should add the surrounded centre",
        );
    }

    #[test]
    fn fill_holes_does_not_touch_exterior() {
        // A single cell — fill_holes should be a no-op (no enclosed void).
        let cells = set_of(&[(0, 0)]);
        let filled = fill_holes(&cells);
        assert_eq!(filled.len(), 1);
    }

    #[test]
    fn collect_member_cells_walks_descendants() {
        // tree: parent(1) -> child(2) -> symbols [s1@(0,0), s2@(1,0)]
        //                 -> direct symbol s3@(2,0)
        let mut containment: HashMap<u128, Vec<u128>> = HashMap::new();
        containment.insert(1, vec![2, 30]);
        containment.insert(2, vec![10, 20]);
        let mut positions: HashMap<u128, HexCoord> = HashMap::new();
        positions.insert(10, HexCoord { q: 0, r: 0 });
        positions.insert(20, HexCoord { q: 1, r: 0 });
        positions.insert(30, HexCoord { q: 2, r: 0 });
        let region_ids: HashSet<u128> = [1, 2].into_iter().collect();
        let cells = collect_member_cells(1, &containment, &positions, &region_ids);
        assert_eq!(cells.len(), 3, "expected 3 placed cells, got {:?}", cells);
    }

    #[test]
    fn compute_hulls_for_regions_skips_empty_regions() {
        // A region with no placed descendants should not appear in the
        // output map.
        let region_ids: HashSet<u128> = [1].into_iter().collect();
        let containment = HashMap::new();
        let positions = HashMap::new();
        let hulls = compute_hulls_for_regions(&region_ids, &containment, &positions, 1.0, 1);
        assert!(hulls.is_empty());
    }

    #[test]
    fn compute_hulls_for_regions_produces_one_entry_per_populated_region() {
        let mut containment: HashMap<u128, Vec<u128>> = HashMap::new();
        containment.insert(1, vec![10]);
        containment.insert(2, vec![20]);
        let mut positions: HashMap<u128, HexCoord> = HashMap::new();
        positions.insert(10, HexCoord { q: 0, r: 0 });
        positions.insert(20, HexCoord { q: 5, r: 0 });
        let region_ids: HashSet<u128> = [1, 2].into_iter().collect();
        let hulls = compute_hulls_for_regions(&region_ids, &containment, &positions, 1.0, 1);
        assert_eq!(hulls.len(), 2);
        assert!(hulls.values().all(|h| !h.polygons.is_empty()));
    }
}
