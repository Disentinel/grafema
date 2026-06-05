//! End-to-end pack → iswap → xswap pipeline driver.
//!
//! Wraps the four layout phases (pack, optional iswap, optional xswap) in a
//! single entry point that the CLI dispatches into. Captures per-phase wall
//! clock and Σ link-length so the report can show iswap/xswap improvements
//! against the post-pack baseline.
//!
//! The [`Incidence`] index is built once and shared across iswap and xswap —
//! both functions take a `&Incidence` and never mutate it, so the caller pays
//! the build cost once.
//!
//! ## Determinism
//!
//! [`run_layout`] is fully deterministic for a given [`LayoutInput`]: pack,
//! iswap, and xswap each have their own determinism guarantees (see the
//! module docs for each). The only non-deterministic field on [`LayoutStats`]
//! is the timing measurements themselves; everything else (swap counts,
//! Σ link length) is byte-identical across runs of the same input.

use std::time::Instant;

use serde::Serialize;

use super::edges::Incidence;
use super::hex::HexCoord;
use super::iswap::iswap;
use super::pack::pack;
use super::synthetic::LayoutInput;
use super::xswap::xswap;

/// Tunable knobs for the pipeline driver.
pub struct RunOpts {
    /// If true, skip iswap and xswap (only the pack phase runs). Useful for
    /// benchmarking the raw packing cost vs the optimisation phases.
    pub pack_only: bool,
}

impl Default for RunOpts {
    fn default() -> Self {
        Self { pack_only: false }
    }
}

/// Pipeline result: final coords + stats. Coords are indexed by
/// [`super::state::NodeIdx`] (same convention as `pack`).
pub struct RunResult {
    /// Final hex coordinates per leaf.
    pub coords: Vec<HexCoord>,
    /// Per-phase timing and improvement metrics.
    pub stats: LayoutStats,
}

/// Per-phase metrics captured during [`run_layout`].
///
/// All `*_ms` fields are wall-clock milliseconds for the corresponding phase;
/// when `pack_only=true`, `iswap_ms` and `xswap_ms` are 0. The `sigma_link_*`
/// trio shows Σ over edges of `hex_distance(coords[src], coords[dst]) * weight`
/// at three pipeline checkpoints — useful for verifying the optimiser is
/// making net progress.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LayoutStats {
    /// Total leaf nodes placed.
    pub n_nodes: usize,
    /// Total edges in the input.
    pub n_edges: usize,
    /// Wall-clock for the pack phase.
    pub pack_ms: u64,
    /// Wall-clock for the iswap phase. 0 if `pack_only`.
    pub iswap_ms: u64,
    /// Wall-clock for the xswap phase. 0 if `pack_only`.
    pub xswap_ms: u64,
    /// Number of swaps iswap accepted. 0 if `pack_only`.
    pub iswap_swaps: u32,
    /// Number of swaps xswap accepted. 0 if `pack_only`.
    pub xswap_swaps: u32,
    /// Σ link length immediately after pack.
    pub sigma_link_pre: f64,
    /// Σ link length after iswap (== `sigma_link_pre` when `pack_only`).
    pub sigma_link_after_iswap: f64,
    /// Σ link length after xswap (== `sigma_link_after_iswap` when `pack_only`).
    pub sigma_link_after_xswap: f64,
}

/// Run the full layout pipeline on `input` with options `opts`.
///
/// Pipeline:
/// 1. `pack` — recursive folder packing from origin (always runs).
/// 2. If `opts.pack_only` is false:
///    a. Build [`Incidence`] index (once).
///    b. `iswap` — intra-folder permutation 2-opt.
///    c. `xswap` — cross-folder boundary swap with connectivity preservation.
///
/// All input-derived data (`tree`, `edges`) is borrowed; only the returned
/// `coords` are freshly allocated.
pub fn run_layout(input: &LayoutInput, opts: &RunOpts) -> RunResult {
    // ── Pack ───────────────────────────────────────────────────────────────
    let t_pack = Instant::now();
    let (mut coords, mut state) = pack(&input.tree, input.n_nodes);
    let pack_ms = t_pack.elapsed().as_millis() as u64;
    let sigma_link_pre = sigma_link(&coords, &input.edges);

    // ── Optimisation phases (optional) ─────────────────────────────────────
    let mut iswap_ms = 0u64;
    let mut xswap_ms = 0u64;
    let mut iswap_swaps = 0u32;
    let mut xswap_swaps = 0u32;
    let mut sigma_link_after_iswap = sigma_link_pre;
    let mut sigma_link_after_xswap = sigma_link_pre;

    if !opts.pack_only {
        // Build the incidence index once and share between the two passes.
        let incidence = Incidence::build(input.n_nodes, &input.edges);

        let t_iswap = Instant::now();
        iswap_swaps = iswap(&mut coords, &mut state, &input.tree, &incidence);
        iswap_ms = t_iswap.elapsed().as_millis() as u64;
        sigma_link_after_iswap = sigma_link(&coords, &input.edges);

        let t_xswap = Instant::now();
        for _ in 0..5 {
            let round = xswap(&mut coords, &mut state, &input.tree, &incidence);
            xswap_swaps += round;
            if round == 0 { break; }
        }
        xswap_ms = t_xswap.elapsed().as_millis() as u64;
        sigma_link_after_xswap = sigma_link(&coords, &input.edges);
    }

    let stats = LayoutStats {
        n_nodes: input.n_nodes,
        n_edges: input.edges.len(),
        pack_ms,
        iswap_ms,
        xswap_ms,
        iswap_swaps,
        xswap_swaps,
        sigma_link_pre,
        sigma_link_after_iswap,
        sigma_link_after_xswap,
    };

    RunResult { coords, stats }
}

/// Σ over all edges of `hex_distance(coords[src], coords[dst]) * weight`.
///
/// Same shape as the test helper in `iswap.rs::total_link_length`, but lives
/// here as a non-test fn so [`run_layout`] can call it.
fn sigma_link(coords: &[HexCoord], edges: &[super::edges::Edge]) -> f64 {
    edges
        .iter()
        .map(|e| coords[e.src as usize].distance(coords[e.dst as usize]) as f64 * e.weight as f64)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::super::synthetic::generate;
    use super::super::validate::validate;
    use super::*;

    #[test]
    fn full_pipeline_reduces_sigma_link() {
        let input = generate(50, 42, 1.5);
        let result = run_layout(&input, &RunOpts { pack_only: false });

        // pack → iswap → xswap monotonically reduces Σ link length.
        assert!(
            result.stats.sigma_link_after_iswap <= result.stats.sigma_link_pre,
            "iswap regressed Σlink: pre={}  post={}",
            result.stats.sigma_link_pre,
            result.stats.sigma_link_after_iswap
        );
        assert!(
            result.stats.sigma_link_after_xswap <= result.stats.sigma_link_after_iswap,
            "xswap regressed Σlink: pre={}  post={}",
            result.stats.sigma_link_after_iswap,
            result.stats.sigma_link_after_xswap
        );
        // End-to-end strict improvement.
        assert!(
            result.stats.sigma_link_after_xswap < result.stats.sigma_link_pre,
            "no end-to-end improvement: pre={}  post={}",
            result.stats.sigma_link_pre,
            result.stats.sigma_link_after_xswap
        );

        // Connectivity preserved.
        let report = validate(&result.coords, &input.tree);
        assert!(
            report.torn.is_empty(),
            "torn folders after full pipeline: {:?}",
            report.torn.iter().map(|t| t.path.clone()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn pack_only_skips_optimisation_phases() {
        let input = generate(50, 42, 1.5);
        let result = run_layout(&input, &RunOpts { pack_only: true });

        assert_eq!(result.stats.iswap_ms, 0, "iswap shouldn't run");
        assert_eq!(result.stats.xswap_ms, 0, "xswap shouldn't run");
        assert_eq!(result.stats.iswap_swaps, 0);
        assert_eq!(result.stats.xswap_swaps, 0);
        assert_eq!(
            result.stats.sigma_link_after_iswap, result.stats.sigma_link_pre,
            "post-iswap Σ should equal pre when iswap skipped"
        );
        assert_eq!(
            result.stats.sigma_link_after_xswap, result.stats.sigma_link_pre,
            "post-xswap Σ should equal pre when xswap skipped"
        );

        // Pack alone must still produce a connected layout per folder.
        let report = validate(&result.coords, &input.tree);
        assert!(
            report.torn.is_empty(),
            "pack alone produced torn folders: {:?}",
            report.torn.iter().map(|t| t.path.clone()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn n_nodes_and_n_edges_match_input() {
        let input = generate(80, 7, 2.0);
        let result = run_layout(&input, &RunOpts::default());
        assert_eq!(result.stats.n_nodes, 80);
        assert_eq!(result.stats.n_edges, input.edges.len());
        assert_eq!(result.coords.len(), 80);
    }

    #[test]
    fn empty_input_runs_without_panic() {
        let input = generate(0, 1, 1.0);
        let result = run_layout(&input, &RunOpts::default());
        assert_eq!(result.coords.len(), 0);
        assert_eq!(result.stats.n_nodes, 0);
        assert_eq!(result.stats.n_edges, 0);
        assert_eq!(result.stats.sigma_link_pre, 0.0);
    }
}
