//! RFD-71 PART A — Shard contention/distribution probe.
//!
//! RFD-71 (per-shard locking) only pays off if concurrent commits hit
//! DIFFERENT shards. Files route to shards by directory hash via
//! `ShardPlanner::compute_shard_id` (`src/storage_v2/shard_planner.rs`):
//! same directory → same shard. A "commit" in production is file/dir-scoped
//! re-analysis, so we model a commit as ALL files in ONE directory.
//!
//! This probe:
//!   1. Synthesizes a realistic large-repo path set (~9000 paths, vscode-like
//!      deep nested tree) — or loads a real path list from argv[1] if given.
//!   2. Runs the actual `ShardPlanner` at the shard counts the resource
//!      profile actually selects (4 default, 8, 16 on big machines).
//!   3. Reports files-per-shard histogram (min/max/mean/stdev) AND the key
//!      metric: for many random pairs of single-directory commits, what
//!      fraction touch DISJOINT shard sets (→ run in parallel under per-shard
//!      locks) vs collide.
//!   4. Verdict per shard count.
//!
//! Run: `cargo run --release --bin probe_shard_distribution [path_list.txt]`

use std::collections::BTreeMap;
use std::collections::HashMap;

use rfdb::storage_v2::ShardPlanner;

/// Deterministic PRNG (xorshift64*) — no external rand dependency, so the
/// synthetic corpus and the random-pair sampling are reproducible.
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

/// Synthesize a vscode-like file-path corpus: a deep, nested directory tree
/// with many top-level areas, varying depth, and varying file counts per dir.
/// Targets ~9000 files. The structure mimics a real monorepo: a handful of
/// big top-level dirs (src, extensions, test, build) with deep subtrees, plus
/// many shallow leaf dirs. Returns the full file list.
fn synth_corpus(target_files: usize) -> Vec<String> {
    let mut rng = Rng::new(0xC0FFEE);

    // Top-level areas with relative weights (mimics vscode layout).
    let areas: &[(&str, u32)] = &[
        ("src/vs/workbench", 40),
        ("src/vs/editor", 12),
        ("src/vs/platform", 10),
        ("src/vs/base", 10),
        ("src/vs/code", 4),
        ("extensions", 30),
        ("test", 8),
        ("build", 4),
        ("scripts", 1),
        ("cli", 3),
        ("remote", 2),
    ];
    // Common leaf segment names to build deep nested dirs.
    let segs: &[&str] = &[
        "browser", "common", "node", "electron-main", "electron-sandbox",
        "contrib", "services", "parts", "views", "actions", "model", "view",
        "widget", "providers", "test", "util", "config", "api", "handlers",
        "components", "internal", "core", "data", "store", "media",
    ];
    let exts: &[&str] = &["ts", "ts", "ts", "tsx", "js", "css"];

    // Build a set of directories first (so files cluster, like a real repo),
    // then fill each with a random number of files.
    let total_weight: u32 = areas.iter().map(|(_, w)| *w).sum();
    let mut dirs: Vec<String> = Vec::new();

    // Generate ~1500 distinct directories (realistic: vscode has ~2-3k dirs).
    let dir_target = 1500;
    while dirs.len() < dir_target {
        // Pick a top-level area weighted.
        let mut pick = rng.below(total_weight as usize) as u32;
        let mut area = areas[0].0;
        for (name, w) in areas {
            if pick < *w {
                area = name;
                break;
            }
            pick -= *w;
        }
        // Depth 0..=4 extra segments below the area (varying nesting).
        let depth = rng.below(5);
        let mut dir = String::from(area);
        for _ in 0..depth {
            dir.push('/');
            dir.push_str(segs[rng.below(segs.len())]);
        }
        dirs.push(dir);
    }
    dirs.sort();
    dirs.dedup();

    // Fill dirs with files until we hit target_files. Files per dir is
    // skewed: most dirs have a few files, some have many.
    let mut files: Vec<String> = Vec::with_capacity(target_files);
    let mut di = 0usize;
    let mut counter = 0u64;
    while files.len() < target_files {
        let dir = &dirs[di % dirs.len()];
        di += 1;
        // 1..=27 files, skewed toward small.
        let r = rng.below(100);
        let n = if r < 60 {
            1 + rng.below(4)
        } else if r < 90 {
            4 + rng.below(8)
        } else {
            12 + rng.below(16)
        };
        for _ in 0..n {
            if files.len() >= target_files {
                break;
            }
            let ext = exts[rng.below(exts.len())];
            files.push(format!("{}/f{}.{}", dir, counter, ext));
            counter += 1;
        }
    }
    files
}

/// Load real paths from a newline-delimited file.
fn load_corpus(path: &str) -> std::io::Result<Vec<String>> {
    let content = std::fs::read_to_string(path)?;
    Ok(content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

fn stdev(values: &[usize], mean: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let var = values
        .iter()
        .map(|&v| {
            let d = v as f64 - mean;
            d * d
        })
        .sum::<f64>()
        / values.len() as f64;
    var.sqrt()
}

fn run_for_shard_count(files: &[String], shard_count: u16) {
    let planner = ShardPlanner::new(shard_count);

    // --- Files-per-shard histogram ---
    let mut per_shard = vec![0usize; shard_count as usize];
    for f in files {
        let sid = planner.compute_shard_id(f) as usize;
        per_shard[sid] += 1;
    }
    let total = files.len();
    let mean = total as f64 / shard_count as f64;
    let min = *per_shard.iter().min().unwrap();
    let max = *per_shard.iter().max().unwrap();
    let sd = stdev(&per_shard, mean);

    println!("\n================ shard_count = {} ================", shard_count);
    println!("files-per-shard histogram ({} files):", total);
    for (i, c) in per_shard.iter().enumerate() {
        let pct = 100.0 * *c as f64 / total as f64;
        let bar_len = (pct / 2.0).round() as usize;
        let bar: String = std::iter::repeat('#').take(bar_len).collect();
        println!("  shard {:>2}: {:>6} ({:>5.1}%) {}", i, c, pct, bar);
    }
    println!(
        "  min={} max={} mean={:.1} stdev={:.1} (CoV={:.1}%)  imbalance max/mean={:.2}x",
        min, max, mean, sd, 100.0 * sd / mean, max as f64 / mean
    );

    // --- Directory → shard mapping ---
    // A "commit" = all files in ONE directory. Since same dir → same shard,
    // a single-dir commit touches EXACTLY ONE shard. So the parallelism
    // question reduces to: pick two distinct random directories, do they map
    // to different shards?
    let mut dir_to_shard: HashMap<String, u16> = HashMap::new();
    for f in files {
        // parent dir
        let dir = match f.rfind('/') {
            Some(i) => &f[..i],
            None => "",
        };
        dir_to_shard
            .entry(dir.to_string())
            .or_insert_with(|| planner.compute_shard_id(f));
    }
    let dirs: Vec<(String, u16)> = dir_to_shard.into_iter().collect();
    let num_dirs = dirs.len();

    // Histogram of distinct DIRECTORIES per shard (the unit of concurrency).
    let mut dirs_per_shard = vec![0usize; shard_count as usize];
    for (_, s) in &dirs {
        dirs_per_shard[*s as usize] += 1;
    }
    println!("  distinct directories = {}", num_dirs);
    print!("  directories-per-shard:");
    {
        let dmean = num_dirs as f64 / shard_count as f64;
        let dmin = *dirs_per_shard.iter().min().unwrap();
        let dmax = *dirs_per_shard.iter().max().unwrap();
        let dsd = stdev(&dirs_per_shard, dmean);
        for (i, c) in dirs_per_shard.iter().enumerate() {
            print!(" {}={}", i, c);
        }
        println!();
        println!(
            "    min={} max={} mean={:.1} stdev={:.1} (CoV={:.1}%)",
            dmin, dmax, dmean, dsd, 100.0 * dsd / dmean
        );
    }

    // --- KEY METRIC: parallelism opportunity ---
    // Model: each commit = files of one directory → one shard. Two commits
    // run in PARALLEL under per-shard locks iff their shard sets are DISJOINT.
    // For single-dir commits the shard set is a singleton, so they collide iff
    // they hit the SAME shard.
    //
    // (a) Analytic, uniform over directories (each dir equally likely to be
    //     re-analyzed): P(collide) = sum_s (d_s/D)^2 where d_s = dirs in shard s.
    let analytic_collide: f64 = dirs_per_shard
        .iter()
        .map(|&d| {
            let p = d as f64 / num_dirs as f64;
            p * p
        })
        .sum();

    // (b) Monte-Carlo over random directory pairs (uniform over dirs) — sanity
    //     check on the analytic value.
    let mut rng = Rng::new(0xBADC0DE);
    let trials = 200_000usize;
    let mut disjoint = 0usize;
    for _ in 0..trials {
        let a = rng.below(num_dirs);
        let mut b = rng.below(num_dirs);
        if num_dirs > 1 {
            while b == a {
                b = rng.below(num_dirs);
            }
        }
        if dirs[a].1 != dirs[b].1 {
            disjoint += 1;
        }
    }
    let mc_parallel = 100.0 * disjoint as f64 / trials as f64;

    // (c) Weighted by file count — large directories (more files) are more
    //     likely to be the unit re-analyzed in a real churn distribution.
    //     Weight each dir by its file count.
    let mut dir_files: BTreeMap<String, usize> = BTreeMap::new();
    for f in files {
        let dir = match f.rfind('/') {
            Some(i) => f[..i].to_string(),
            None => String::new(),
        };
        *dir_files.entry(dir).or_insert(0) += 1;
    }
    // Build weighted shard mass.
    let mut shard_file_mass = vec![0usize; shard_count as usize];
    for (dir, n) in &dir_files {
        let sid = planner.compute_shard_id(&format!("{}/x", dir)) as usize;
        shard_file_mass[sid] += *n;
    }
    let total_mass: usize = shard_file_mass.iter().sum();
    let weighted_collide: f64 = shard_file_mass
        .iter()
        .map(|&m| {
            let p = m as f64 / total_mass as f64;
            p * p
        })
        .sum();

    println!("  --- PARALLELISM OPPORTUNITY (single-dir commit pairs) ---");
    println!(
        "    uniform-over-dirs:   {:>5.1}% parallel  ({:.1}% collide)  [analytic]",
        100.0 * (1.0 - analytic_collide),
        100.0 * analytic_collide
    );
    println!(
        "    uniform-over-dirs:   {:>5.1}% parallel               [monte-carlo {} trials]",
        mc_parallel, trials
    );
    println!(
        "    file-count-weighted: {:>5.1}% parallel  ({:.1}% collide)  [analytic]",
        100.0 * (1.0 - weighted_collide),
        100.0 * weighted_collide
    );

    // Baseline reference: ideal uniform distribution → P(collide)=1/N.
    let ideal_parallel = 100.0 * (1.0 - 1.0 / shard_count as f64);
    println!(
        "    ideal-uniform ref:   {:>5.1}% parallel  (= 1 - 1/{})",
        ideal_parallel, shard_count
    );

    // --- Verdict ---
    let parallel = 100.0 * (1.0 - analytic_collide);
    let verdict = if parallel >= ideal_parallel - 5.0 {
        "GOOD — distribution near ideal; per-shard locking yields full write parallelism"
    } else if parallel >= ideal_parallel - 15.0 {
        "OK — modest skew; per-shard locking still yields meaningful parallelism"
    } else {
        "WEAK — heavy skew concentrates commits on few shards; limited parallelism"
    };
    println!("  VERDICT (shard_count={}): {}", shard_count, verdict);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (files, source) = if args.len() > 1 {
        match load_corpus(&args[1]) {
            Ok(f) => (f, format!("real path list: {}", args[1])),
            Err(e) => {
                eprintln!("failed to read {}: {} — falling back to synthetic", args[1], e);
                (synth_corpus(9000), "synthetic vscode-like (~9000)".to_string())
            }
        }
    } else {
        (synth_corpus(9000), "synthetic vscode-like (~9000)".to_string())
    };

    println!("RFD-71 PART A — shard distribution / contention probe");
    println!("corpus: {} ({} files)", source, files.len());

    // The resource profile selects shard_count in {1,4,8,16}:
    //   - default / <2GB RAM: 1 or 4 (TuningProfile::default = 4)
    //   - big machines: cpu.next_power_of_two().min(16) → 8 or 16
    // We report the meaningful multi-shard cases.
    for &sc in &[4u16, 8, 16] {
        run_for_shard_count(&files, sc);
    }

    println!("\nNOTE: a single-directory commit touches exactly ONE shard");
    println!("(same dir -> same shard by design). Parallelism is therefore");
    println!("bounded by how evenly distinct directories spread across shards.");
}
