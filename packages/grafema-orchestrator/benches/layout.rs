//! Criterion benchmarks for the layout pipeline.
//!
//! Measures `pack_only` (just the recursive packer) and `full_pipeline`
//! (pack → iswap → xswap) at three input sizes (1k, 10k, 50k leaves).
//! Uses the deterministic synthetic fixture so benchmark numbers are
//! comparable across machines and across commits — same seed, same input.
//!
//! ## Running
//!
//! ```bash
//! cargo bench --bench layout                    # full suite
//! cargo bench --bench layout -- pack_only/1000  # single benchmark
//! ```
//!
//! ## Sample size
//!
//! Criterion's default of 100 samples × per-iter time gets prohibitive at
//! 50k leaves (xswap alone is hundreds of ms). We drop to 10 samples
//! per benchmark — enough for stable means but ~10× faster wall time.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use grafema_orchestrator::layout::{generate, run_layout, RunOpts};

fn bench_layout(c: &mut Criterion) {
    let mut group = c.benchmark_group("layout");
    // 10 samples — see module docs for rationale.
    group.sample_size(10);

    for &n in &[1_000usize, 10_000, 50_000] {
        // Generate the input once per size, share across pack-only and
        // full-pipeline runs. The runner takes `&LayoutInput`, so no clone
        // needed across iterations.
        let input = generate(n, 42, 1.5);

        // Pack-only: cheapest phase, lowest variance.
        group.bench_with_input(BenchmarkId::new("pack_only", n), &input, |b, input| {
            b.iter(|| run_layout(input, &RunOpts { pack_only: true }))
        });

        // Full pipeline: pack → iswap → xswap.
        group.bench_with_input(BenchmarkId::new("full_pipeline", n), &input, |b, input| {
            b.iter(|| run_layout(input, &RunOpts { pack_only: false }))
        });
    }

    group.finish();
}

criterion_group!(benches, bench_layout);
criterion_main!(benches);
