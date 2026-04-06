//! Simulated annealing hex layout engine.
//!
//! Port of `packages/gui/src/store/hexLayout.ts` to Rust.
//! Runs inside the RFDB process with zero-copy access to graph data.
//!
//! # Algorithm
//!
//! 1. Initial placement: competitive flood-fill per region (deterministic)
//! 2. SA optimization: swap (same region) + migrate (to adjacent tile) moves
//! 3. Cost = sum of cube distances for semantic (non-structural) edges
//! 4. O(1) hex-ring connectivity check for migrate moves
//! 5. 1-tile gap enforced between regions

use std::collections::{HashMap, HashSet};

use crate::container_hierarchy::ContainerTree;

// ── Hex coordinate math ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HexCoord {
    pub q: i32,
    pub r: i32,
}

impl HexCoord {
    pub fn new(q: i32, r: i32) -> Self { Self { q, r } }

    pub fn distance(self, other: Self) -> i32 {
        let dq = (self.q - other.q).abs();
        let dr = (self.r - other.r).abs();
        let ds = ((self.q + self.r) - (other.q + other.r)).abs();
        dq.max(dr).max(ds)
    }
}

const CUBE_DIRS: [(i32, i32); 6] = [
    (1, 0), (0, 1), (-1, 1),
    (-1, 0), (0, -1), (1, -1),
];

// ── Deterministic PRNG (mulberry32) ─────────────────────────────────────

fn mulberry32(seed: &mut u32) -> f64 {
    *seed = seed.wrapping_add(0x6D2B79F5);
    let mut t = (*seed ^ (*seed >> 15)).wrapping_mul(1 | *seed);
    t = (t.wrapping_add(t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
    ((t ^ (t >> 14)) as f64) / 4294967296.0
}

// ── Edge types excluded from layout cost ────────────────────────────────

const STRUCTURAL_EDGES: &[&str] = &[
    "CONTAINS", "HAS_SCOPE", "HAS_BODY", "DECLARES",
];

fn is_structural(edge_type: &str) -> bool {
    STRUCTURAL_EDGES.iter().any(|&s| s == edge_type)
}

// ── Layout input ────────────────────────────────────────────────────────

/// Node for layout (lightweight, references external data).
#[derive(Debug, Clone)]
pub struct LayoutNode {
    pub idx: u32,
    pub region: String,
    pub degree: u32,
}

/// Edge for layout.
#[derive(Debug, Clone)]
pub struct LayoutEdge {
    pub src: u32,
    pub dst: u32,
    pub edge_type: String,
}

/// Position snapshot for streaming to client.
#[derive(Debug, Clone)]
pub struct SaSnapshot {
    /// (nodeIndex, q, r) for every node
    pub positions: Vec<(u32, i16, i16)>,
    pub cost: i64,
    pub iteration: usize,
    pub temperature: f64,
    pub settled: bool,
}

impl Default for SaSnapshot {
    fn default() -> Self {
        Self {
            positions: Vec::new(),
            cost: 0,
            iteration: 0,
            temperature: 0.0,
            settled: false,
        }
    }
}

// ── SA Engine ───────────────────────────────────────────────────────────

pub struct SaEngine {
    n: usize,
    /// Node index → hex coord
    tile_coords: Vec<HexCoord>,
    /// Hex coord → region name
    claimed: HashMap<HexCoord, u16>,
    /// Hex coord → node index
    tile_to_node: HashMap<HexCoord, u32>,
    /// Node index → region index
    node_region: Vec<u16>,
    /// Region index → [node indices]
    region_members: Vec<Vec<u32>>,
    /// Region index → name
    region_names: Vec<String>,
    /// Semantic adjacency: node → [(neighbor, weight)]
    semantic_adj: Vec<Vec<u32>>,
    /// All node indices (for random selection)
    all_indices: Vec<u32>,
    /// PRNG seed
    rng_seed: u32,
    /// Current temperature
    temperature: f64,
    /// Cooling factor
    cool: f64,
    /// Total iterations run
    pub total_iterations: usize,
}

impl SaEngine {
    /// Create SA engine from layout data + container tree.
    pub fn new(
        nodes: &[LayoutNode],
        edges: &[LayoutEdge],
        container_tree: &ContainerTree,
    ) -> Self {
        let n = nodes.len();

        // Build region mapping
        let region_name_set: Vec<String> = container_tree.sa_region_names();
        let region_idx_map: HashMap<&str, u16> = region_name_set
            .iter()
            .enumerate()
            .map(|(i, name)| (name.as_str(), i as u16))
            .collect();

        let node_region: Vec<u16> = (0..n)
            .map(|i| {
                let region = container_tree.sa_region(i as u32);
                *region_idx_map.get(region).unwrap_or(&0)
            })
            .collect();

        let mut region_members: Vec<Vec<u32>> = vec![Vec::new(); region_name_set.len()];
        for (i, &ri) in node_region.iter().enumerate() {
            region_members[ri as usize].push(i as u32);
        }

        // Build semantic adjacency (exclude structural edges)
        let mut semantic_adj: Vec<Vec<u32>> = vec![Vec::new(); n];
        for edge in edges {
            if is_structural(&edge.edge_type) {
                continue;
            }
            let s = edge.src as usize;
            let d = edge.dst as usize;
            if s < n && d < n {
                semantic_adj[s].push(edge.dst);
                semantic_adj[d].push(edge.src);
            }
        }

        // Initial placement: competitive flood-fill
        let mut tile_coords = vec![HexCoord::new(0, 0); n];
        let mut claimed: HashMap<HexCoord, u16> = HashMap::new();
        let mut tile_to_node: HashMap<HexCoord, u32> = HashMap::new();

        // Place region seeds
        let mut sorted_regions: Vec<usize> = (0..region_name_set.len()).collect();
        sorted_regions.sort_by(|&a, &b| region_members[b].len().cmp(&region_members[a].len()));

        // Cross-region edge weights for seed placement
        let mut pair_weight: HashMap<(u16, u16), u32> = HashMap::new();
        for edge in edges {
            if is_structural(&edge.edge_type) { continue; }
            let s = edge.src as usize;
            let d = edge.dst as usize;
            if s >= n || d >= n { continue; }
            let r1 = node_region[s];
            let r2 = node_region[d];
            if r1 != r2 {
                let key = if r1 < r2 { (r1, r2) } else { (r2, r1) };
                *pair_weight.entry(key).or_insert(0) += 1;
            }
        }

        let mut seeds: HashMap<u16, HexCoord> = HashMap::new();
        if !sorted_regions.is_empty() {
            let first = sorted_regions[0] as u16;
            seeds.insert(first, HexCoord::new(0, 0));
            claimed.insert(HexCoord::new(0, 0), first);
        }

        for &ri in sorted_regions.iter().skip(1) {
            let region = ri as u16;
            let mut best_target = HexCoord::new(0, 0);
            let mut best_weight = 0u32;
            for (&placed, &coord) in &seeds {
                let key = if region < placed { (region, placed) } else { (placed, region) };
                let w = pair_weight.get(&key).copied().unwrap_or(0);
                if w > best_weight {
                    best_weight = w;
                    best_target = coord;
                }
            }

            let search_start = if best_weight > 0 { 3 } else { 6 };
            let mut placed = false;
            for rad in search_start..30 {
                if placed { break; }
                let mut rq = best_target.q + rad * CUBE_DIRS[4].0;
                let mut rr = best_target.r + rad * CUBE_DIRS[4].1;
                for side in 0..6 {
                    if placed { break; }
                    for _ in 0..rad {
                        if placed { break; }
                        let coord = HexCoord::new(rq, rr);
                        if !claimed.contains_key(&coord) {
                            seeds.insert(region, coord);
                            claimed.insert(coord, region);
                            placed = true;
                        }
                        rq += CUBE_DIRS[side].0;
                        rr += CUBE_DIRS[side].1;
                    }
                }
            }
        }

        // Gap enforcement helper
        let can_claim = |coord: HexCoord, region: u16, claimed: &HashMap<HexCoord, u16>| -> bool {
            for &(dq, dr) in &CUBE_DIRS {
                let nk = HexCoord::new(coord.q + dq, coord.r + dr);
                if let Some(&owner) = claimed.get(&nk) {
                    if owner != region { return false; }
                }
            }
            true
        };

        // Flood fill
        let mut frontiers: HashMap<u16, Vec<HexCoord>> = HashMap::new();
        let mut remaining: HashMap<u16, usize> = HashMap::new();
        for (ri, members) in region_members.iter().enumerate() {
            let region = ri as u16;
            if members.is_empty() { continue; }
            remaining.insert(region, members.len().saturating_sub(1));
            let seed = seeds.get(&region).copied().unwrap_or(HexCoord::new(0, 0));
            let mut frontier = Vec::new();
            for &(dq, dr) in &CUBE_DIRS {
                let nk = HexCoord::new(seed.q + dq, seed.r + dr);
                if !claimed.contains_key(&nk) {
                    frontier.push(nk);
                }
            }
            frontiers.insert(region, frontier);
        }

        for _ in 0..500 {
            let mut any = false;
            for (ri, members) in region_members.iter().enumerate() {
                let region = ri as u16;
                let need = remaining.get(&region).copied().unwrap_or(0);
                if need == 0 { continue; }
                let frontier = match frontiers.get_mut(&region) {
                    Some(f) => f,
                    None => continue,
                };
                frontier.retain(|c| !claimed.contains_key(c));
                if frontier.is_empty() { continue; }

                // Pick tile with most same-region neighbors
                let mut best_idx = 0;
                let mut best_score: i32 = -1;
                for (fi, &coord) in frontier.iter().enumerate() {
                    if !can_claim(coord, region, &claimed) { continue; }
                    let mut score = 0i32;
                    for &(dq, dr) in &CUBE_DIRS {
                        if claimed.get(&HexCoord::new(coord.q + dq, coord.r + dr)) == Some(&region) {
                            score += 1;
                        }
                    }
                    if score > best_score { best_score = score; best_idx = fi; }
                }
                if best_score < 0 { continue; }

                let chosen = frontier.swap_remove(best_idx);
                claimed.insert(chosen, region);
                remaining.insert(region, need - 1);
                any = true;

                for &(dq, dr) in &CUBE_DIRS {
                    let nk = HexCoord::new(chosen.q + dq, chosen.r + dr);
                    if !claimed.contains_key(&nk) {
                        frontier.push(nk);
                    }
                }
            }
            if !any { break; }
        }

        // Assign nodes to tiles by degree (important near center)
        for (ri, members) in region_members.iter().enumerate() {
            let region = ri as u16;
            let seed = seeds.get(&region).copied().unwrap_or(HexCoord::new(0, 0));

            let mut tiles: Vec<HexCoord> = claimed
                .iter()
                .filter(|(_, &r)| r == region)
                .map(|(&c, _)| c)
                .collect();
            tiles.sort_by_key(|&c| c.distance(seed));

            let mut sorted_members = members.clone();
            sorted_members.sort_by(|&a, &b| {
                nodes[b as usize].degree.cmp(&nodes[a as usize].degree)
            });

            for (j, &ni) in sorted_members.iter().enumerate() {
                if j < tiles.len() {
                    tile_coords[ni as usize] = tiles[j];
                    tile_to_node.insert(tiles[j], ni);
                }
            }
        }

        // SA parameters
        let iterations = (n * 1000).min(100_000);
        let t_start: f64 = 8.0;
        let t_end: f64 = 0.01;
        let cool = (t_end / t_start).powf(1.0 / iterations as f64);
        let rng_seed = (n as u32)
            .wrapping_mul(31)
            .wrapping_add((edges.len() as u32).wrapping_mul(37))
            .wrapping_add((region_name_set.len() as u32).wrapping_mul(41));

        let all_indices: Vec<u32> = (0..n as u32).collect();

        SaEngine {
            n,
            tile_coords,
            claimed,
            tile_to_node,
            node_region,
            region_members,
            region_names: region_name_set,
            semantic_adj,
            all_indices,
            rng_seed,
            temperature: t_start,
            cool,
            total_iterations: 0,
        }
    }

    /// Total iterations planned.
    pub fn max_iterations(&self) -> usize {
        (self.n * 1000).min(100_000)
    }

    /// Node-local cost (sum of distances to semantic neighbors).
    /// Node-local cost: semantic edge distances + compactness penalty.
    /// Exposed sides (neighbors not same region) add +1 penalty each.
    fn node_cost(&self, ni: u32) -> i64 {
        let coord = self.tile_coords[ni as usize];
        let mut cost = 0i64;
        for &neighbor in &self.semantic_adj[ni as usize] {
            cost += coord.distance(self.tile_coords[neighbor as usize]) as i64;
        }
        // Compactness: penalize exposed sides (weight 3 — must dominate over edge pull)
        let region = self.node_region[ni as usize];
        for &(dq, dr) in &CUBE_DIRS {
            let nk = HexCoord::new(coord.q + dq, coord.r + dr);
            if self.claimed.get(&nk) != Some(&region) {
                cost += 3;
            }
        }
        cost
    }

    /// Total cost across all semantic edges.
    pub fn total_cost(&self) -> i64 {
        let mut cost = 0i64;
        for ni in 0..self.n {
            for &neighbor in &self.semantic_adj[ni] {
                if (ni as u32) < neighbor { // count each edge once
                    cost += self.tile_coords[ni].distance(self.tile_coords[neighbor as usize]) as i64;
                }
            }
        }
        cost
    }

    /// O(1) connectivity check: would removing this tile disconnect its region?
    /// Local BFS connectivity: checks if all same-region neighbors are reachable
    /// without going through the vacated tile. Radius-3 BFS, not full region scan.
    fn would_disconnect(&self, coord: HexCoord, region: u16) -> bool {
        let mut neighbors = Vec::new();
        for &(dq, dr) in &CUBE_DIRS {
            let nk = HexCoord::new(coord.q + dq, coord.r + dr);
            if self.claimed.get(&nk) == Some(&region) {
                neighbors.push(nk);
            }
        }
        if neighbors.len() <= 1 { return false; }

        // BFS from first neighbor, excluding vacated tile, limited to radius 3
        let mut visited = HashSet::new();
        let mut queue = std::collections::VecDeque::new();
        visited.insert(neighbors[0]);
        queue.push_back(neighbors[0]);

        while let Some(cur) = queue.pop_front() {
            if cur.distance(coord) > 3 { continue; }
            for &(dq, dr) in &CUBE_DIRS {
                let nk = HexCoord::new(cur.q + dq, cur.r + dr);
                if nk == coord { continue; } // skip vacated
                if visited.contains(&nk) { continue; }
                if self.claimed.get(&nk) == Some(&region) {
                    visited.insert(nk);
                    queue.push_back(nk);
                }
            }
        }

        neighbors.iter().any(|nk| !visited.contains(nk))
    }

    /// Gap enforcement: can this tile be claimed by this region?
    fn can_claim(&self, coord: HexCoord, region: u16) -> bool {
        for &(dq, dr) in &CUBE_DIRS {
            let nk = HexCoord::new(coord.q + dq, coord.r + dr);
            if let Some(&owner) = self.claimed.get(&nk) {
                if owner != region { return false; }
            }
        }
        true
    }

    /// Run a batch of SA iterations. Returns (cost, accepted_count).
    pub fn run_batch(&mut self, iterations: usize) -> (i64, usize) {
        let mut accepted = 0usize;
        let n = self.n;
        let num_regions = self.region_names.len();

        for _ in 0..iterations {
            self.temperature *= self.cool;

            let move_type = mulberry32(&mut self.rng_seed);

            if move_type < 0.5 {
                // Move A: swap two nodes in same region
                let ri = (mulberry32(&mut self.rng_seed) * num_regions as f64) as usize % num_regions;
                let members = &self.region_members[ri];
                if members.len() < 2 { continue; }

                let ia = (mulberry32(&mut self.rng_seed) * members.len() as f64) as usize % members.len();
                let ib = (mulberry32(&mut self.rng_seed) * members.len() as f64) as usize % members.len();
                if ia == ib { continue; }

                let ni = members[ia];
                let nj = members[ib];
                let ci = self.tile_coords[ni as usize];
                let cj = self.tile_coords[nj as usize];
                let cost_before = self.node_cost(ni) + self.node_cost(nj);

                // Swap
                self.tile_coords[ni as usize] = cj;
                self.tile_coords[nj as usize] = ci;
                let cost_after = self.node_cost(ni) + self.node_cost(nj);
                let delta = cost_after - cost_before;

                if delta < 0 || mulberry32(&mut self.rng_seed) < (-delta as f64 / self.temperature).exp() {
                    self.tile_to_node.insert(cj, ni);
                    self.tile_to_node.insert(ci, nj);
                    accepted += 1;
                } else {
                    self.tile_coords[ni as usize] = ci;
                    self.tile_coords[nj as usize] = cj;
                }
            } else {
                // Move B: migrate node to adjacent unclaimed tile
                let ni = self.all_indices[(mulberry32(&mut self.rng_seed) * n as f64) as usize % n];
                let region = self.node_region[ni as usize];
                let cur_tile = self.tile_coords[ni as usize];

                // Find unclaimed neighbors
                let mut candidates = Vec::with_capacity(6);
                for &(dq, dr) in &CUBE_DIRS {
                    let nk = HexCoord::new(cur_tile.q + dq, cur_tile.r + dr);
                    if !self.claimed.contains_key(&nk) {
                        candidates.push(nk);
                    }
                }
                if candidates.is_empty() { continue; }

                let target = candidates[(mulberry32(&mut self.rng_seed) * candidates.len() as f64) as usize % candidates.len()];

                // Must be adjacent to at least one same-region tile (besides current)
                let mut has_adj = false;
                for &(dq, dr) in &CUBE_DIRS {
                    let nk = HexCoord::new(target.q + dq, target.r + dr);
                    if nk != cur_tile && self.claimed.get(&nk) == Some(&region) {
                        has_adj = true;
                        break;
                    }
                }
                if !has_adj { continue; }

                // Gap check (temporarily remove cur_tile)
                self.claimed.remove(&cur_tile);
                let gap_ok = self.can_claim(target, region);
                self.claimed.insert(cur_tile, region);
                if !gap_ok { continue; }

                // Connectivity check (O(1))
                if self.would_disconnect(cur_tile, region) { continue; }

                let cost_before = self.node_cost(ni);

                // Move
                self.tile_coords[ni as usize] = target;
                self.claimed.remove(&cur_tile);
                self.claimed.insert(target, region);
                self.tile_to_node.remove(&cur_tile);
                self.tile_to_node.insert(target, ni);

                let cost_after = self.node_cost(ni);
                let delta = cost_after - cost_before;

                if delta < 0 || mulberry32(&mut self.rng_seed) < (-delta as f64 / self.temperature).exp() {
                    accepted += 1;
                } else {
                    // Revert
                    self.tile_coords[ni as usize] = cur_tile;
                    self.claimed.remove(&target);
                    self.claimed.insert(cur_tile, region);
                    self.tile_to_node.remove(&target);
                    self.tile_to_node.insert(cur_tile, ni);
                }
            }

            self.total_iterations += 1;
        }

        (self.total_cost(), accepted)
    }

    /// Return current positions as (nodeIndex, q, r) tuples.
    pub fn snapshot(&self) -> Vec<(u32, i16, i16)> {
        self.tile_coords
            .iter()
            .enumerate()
            .map(|(i, c)| (i as u32, c.q as i16, c.r as i16))
            .collect()
    }

    /// Current temperature.
    pub fn temperature(&self) -> f64 {
        self.temperature
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::container_hierarchy::{ContainerTree, HierarchyLevel, ContainerRule, NodeRef, EdgeRef};

    fn make_test_data() -> (Vec<LayoutNode>, Vec<LayoutEdge>, ContainerTree) {
        let node_refs = vec![
            NodeRef { idx: 0, id: 1, node_type: "FUNCTION".into(), file: "pkg/a/foo.ts".into(), name: "foo".into(), metadata: None },
            NodeRef { idx: 1, id: 2, node_type: "FUNCTION".into(), file: "pkg/a/bar.ts".into(), name: "bar".into(), metadata: None },
            NodeRef { idx: 2, id: 3, node_type: "FUNCTION".into(), file: "pkg/a/baz.ts".into(), name: "baz".into(), metadata: None },
            NodeRef { idx: 3, id: 4, node_type: "FUNCTION".into(), file: "pkg/b/qux.ts".into(), name: "qux".into(), metadata: None },
            NodeRef { idx: 4, id: 5, node_type: "FUNCTION".into(), file: "pkg/b/quux.ts".into(), name: "quux".into(), metadata: None },
        ];

        let edge_refs = vec![
            EdgeRef { src_idx: 0, dst_idx: 1, edge_type: "CALLS".into() },
            EdgeRef { src_idx: 1, dst_idx: 2, edge_type: "CALLS".into() },
            EdgeRef { src_idx: 3, dst_idx: 4, edge_type: "CALLS".into() },
            EdgeRef { src_idx: 0, dst_idx: 3, edge_type: "CALLS".into() },
            EdgeRef { src_idx: 0, dst_idx: 1, edge_type: "CONTAINS".into() }, // structural, excluded
        ];

        let hierarchy = vec![
            HierarchyLevel::new("package", ContainerRule::FilePrefix(2)),
        ];
        let tree = ContainerTree::build(&hierarchy, &node_refs, &edge_refs);

        let layout_nodes: Vec<LayoutNode> = node_refs.iter().map(|n| LayoutNode {
            idx: n.idx,
            region: tree.sa_region(n.idx).to_string(),
            degree: 0,
        }).collect();

        let layout_edges: Vec<LayoutEdge> = edge_refs.iter().map(|e| LayoutEdge {
            src: e.src_idx,
            dst: e.dst_idx,
            edge_type: e.edge_type.clone(),
        }).collect();

        (layout_nodes, layout_edges, tree)
    }

    #[test]
    fn test_sa_engine_creation() {
        let (nodes, edges, tree) = make_test_data();
        let engine = SaEngine::new(&nodes, &edges, &tree);
        assert_eq!(engine.n, 5);
        assert_eq!(engine.region_names.len(), 2); // pkg/a and pkg/b
    }

    #[test]
    fn test_sa_initial_placement() {
        let (nodes, edges, tree) = make_test_data();
        let engine = SaEngine::new(&nodes, &edges, &tree);

        // All nodes should have unique positions
        let positions: HashSet<HexCoord> = engine.tile_coords.iter().copied().collect();
        assert_eq!(positions.len(), 5);
    }

    #[test]
    fn test_sa_cost_decreases_or_stable() {
        let (nodes, edges, tree) = make_test_data();
        let mut engine = SaEngine::new(&nodes, &edges, &tree);
        let initial_cost = engine.total_cost();

        engine.run_batch(10_000);
        let final_cost = engine.total_cost();

        // Cost should not increase significantly (SA finds better or equal)
        assert!(final_cost <= initial_cost + 5, "cost increased: {} → {}", initial_cost, final_cost);
    }

    #[test]
    fn test_sa_snapshot_format() {
        let (nodes, edges, tree) = make_test_data();
        let engine = SaEngine::new(&nodes, &edges, &tree);
        let snapshot = engine.snapshot();

        assert_eq!(snapshot.len(), 5);
        for (idx, _q, _r) in &snapshot {
            assert!(*idx < 5);
        }
    }

    #[test]
    fn test_sa_deterministic() {
        let (nodes, edges, tree) = make_test_data();

        let mut engine1 = SaEngine::new(&nodes, &edges, &tree);
        engine1.run_batch(5_000);
        let snap1 = engine1.snapshot();

        let mut engine2 = SaEngine::new(&nodes, &edges, &tree);
        engine2.run_batch(5_000);
        let snap2 = engine2.snapshot();

        assert_eq!(snap1, snap2, "SA should be deterministic with same seed");
    }

    #[test]
    fn test_hex_distance() {
        assert_eq!(HexCoord::new(0, 0).distance(HexCoord::new(0, 0)), 0);
        assert_eq!(HexCoord::new(0, 0).distance(HexCoord::new(1, 0)), 1);
        assert_eq!(HexCoord::new(0, 0).distance(HexCoord::new(2, -1)), 2);
        assert_eq!(HexCoord::new(0, 0).distance(HexCoord::new(3, 0)), 3);
    }

    #[test]
    fn test_would_disconnect() {
        let (nodes, edges, tree) = make_test_data();
        let engine = SaEngine::new(&nodes, &edges, &tree);

        // Test with a coord that has only 1 same-region neighbor → never disconnects
        // (This is hard to test without knowing exact placement, so just verify it doesn't panic)
        for &coord in engine.tile_coords.iter() {
            let region = engine.claimed.get(&coord).copied().unwrap_or(0);
            let _ = engine.would_disconnect(coord, region);
        }
    }

    #[test]
    fn test_mulberry32_deterministic() {
        let mut s1 = 42u32;
        let mut s2 = 42u32;
        let v1: Vec<f64> = (0..10).map(|_| mulberry32(&mut s1)).collect();
        let v2: Vec<f64> = (0..10).map(|_| mulberry32(&mut s2)).collect();
        assert_eq!(v1, v2);
        // Should be in [0, 1)
        for v in &v1 {
            assert!(*v >= 0.0 && *v < 1.0);
        }
    }
}
