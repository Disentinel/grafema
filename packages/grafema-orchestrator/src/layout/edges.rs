//! Edge-list input shape for the layout optimisers (`iswap`, `xswap`).
//!
//! The pack phase only needs the folder tree — no edges. Once we move to
//! optimisation, every link contributes to the per-swap delta calculation.
//! `Incidence` materialises a per-node adjacency list once so the inner loop
//! of the optimiser is single-pass.
//!
//! Mirrors the JS reference's `iswapOptimise` setup
//! (`sandbox/hex-sandbox/src/pack.js:732-738`):
//!
//! ```js
//! const incident = new Map();
//! for (const n of map.nodes.values()) incident.set(n.id, []);
//! for (const l of map.links) {
//!   incident.get(l.source.id)?.push(l);
//!   incident.get(l.target.id)?.push(l);
//! }
//! ```
//!
//! Each edge is stored once per endpoint (so an a→b edge appears in both
//! `incidence[a]` and `incidence[b]`). The optimiser's `swap_delta` reads
//! `incidence[a]` and `incidence[b]` independently, so this duplication keeps
//! the loop branch-free.

use super::state::NodeIdx;

/// A single weighted edge between two nodes.
///
/// `weight` is `f32` end-to-end to match the JS reference's `link.weight`
/// and to keep the per-swap delta computation cheap (no f32→f64 fan-out).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Edge {
    /// Source node index.
    pub src: NodeIdx,
    /// Destination node index.
    pub dst: NodeIdx,
    /// Edge weight (≥ 0 by convention; not enforced).
    pub weight: f32,
}

/// Per-node incidence index. Built once before any iswap/xswap pass.
///
/// `by_node[i]` lists `(other_endpoint, weight)` for every edge incident to
/// node `i`. An edge `a↔b` therefore appears twice — once in `by_node[a]`
/// (with `other = b`) and once in `by_node[b]` (with `other = a`). This is
/// the same shape as the JS reference's `incident` map.
///
/// Self-loops (`src == dst`) are silently skipped during construction.
pub struct Incidence {
    /// For each node: list of (other_node, weight) for every incident edge.
    pub by_node: Vec<Vec<(NodeIdx, f32)>>,
}

impl Incidence {
    /// Build an `Incidence` index from a flat edge list.
    ///
    /// `n_nodes` sets the size of `by_node`; nodes with no edges keep an
    /// empty `Vec`.
    ///
    /// Edges with `src == dst` are silently skipped (self-loops have zero
    /// distance change under swap, so they would only add noise).
    pub fn build(n_nodes: usize, edges: &[Edge]) -> Self {
        let mut by_node: Vec<Vec<(NodeIdx, f32)>> = vec![Vec::new(); n_nodes];
        for e in edges {
            if e.src == e.dst {
                continue;
            }
            by_node[e.src as usize].push((e.dst, e.weight));
            by_node[e.dst as usize].push((e.src, e.weight));
        }
        Self { by_node }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_edges_produces_empty_incidence_per_node() {
        let inc = Incidence::build(4, &[]);
        assert_eq!(inc.by_node.len(), 4);
        for v in &inc.by_node {
            assert!(v.is_empty());
        }
    }

    #[test]
    fn single_edge_appears_in_both_endpoints() {
        let edges = [Edge { src: 0, dst: 1, weight: 2.5 }];
        let inc = Incidence::build(2, &edges);
        assert_eq!(inc.by_node[0], vec![(1, 2.5)]);
        assert_eq!(inc.by_node[1], vec![(0, 2.5)]);
    }

    #[test]
    fn self_loop_is_skipped() {
        let edges = [
            Edge { src: 0, dst: 0, weight: 9.0 }, // self-loop, dropped
            Edge { src: 0, dst: 1, weight: 1.0 },
        ];
        let inc = Incidence::build(2, &edges);
        assert_eq!(inc.by_node[0], vec![(1, 1.0)]);
        assert_eq!(inc.by_node[1], vec![(0, 1.0)]);
    }

    #[test]
    fn multiple_edges_accumulate_per_node() {
        // 3 nodes, edges: 0-1, 0-2, 1-2.
        let edges = [
            Edge { src: 0, dst: 1, weight: 1.0 },
            Edge { src: 0, dst: 2, weight: 2.0 },
            Edge { src: 1, dst: 2, weight: 3.0 },
        ];
        let inc = Incidence::build(3, &edges);
        assert_eq!(inc.by_node[0].len(), 2);
        assert_eq!(inc.by_node[1].len(), 2);
        assert_eq!(inc.by_node[2].len(), 2);
        // Pair (other, weight) lookup — order matches insertion.
        assert_eq!(inc.by_node[0], vec![(1, 1.0), (2, 2.0)]);
        assert_eq!(inc.by_node[1], vec![(0, 1.0), (2, 3.0)]);
        assert_eq!(inc.by_node[2], vec![(0, 2.0), (1, 3.0)]);
    }

    #[test]
    fn weight_is_f32() {
        // Compile-time check via type assertion on the field access.
        let e = Edge { src: 0, dst: 1, weight: 1.25_f32 };
        let _: f32 = e.weight;
    }
}
