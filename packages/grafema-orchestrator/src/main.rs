use grafema_orchestrator::{analyzer, config, directory_nodes, discovery, gc, plugin, process_pool, profiler, rfdb, source_hash};
#[cfg(feature = "ruby")]
use grafema_orchestrator::ruby_resolver;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;


/// Tag virtual resolution output nodes with a synthetic file for cleanup.
///
/// Resolution plugins create virtual nodes (GLOBAL::*, BUILTIN::*) with no file.
/// Without a synthetic file, `commit_batch` can't clean them up (file-based deletion).
/// This assigns a per-plugin synthetic file so old virtual nodes are properly
/// tombstoned before new ones are added.
fn tag_virtual_nodes(output: &mut plugin::PluginOutput, plugin_name: &str) {
    let synthetic_file = format!("__grafema_virtual/{}", plugin_name);
    for node in &mut output.nodes {
        if node.file.is_none() || node.file.as_deref() == Some("") {
            node.file = Some(synthetic_file.clone());
        }
    }
}

#[derive(Parser)]
#[command(name = "grafema-orchestrator", version, about = "Grafema analysis pipeline orchestrator")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run analysis on a project
    Analyze {
        /// Path to grafema.config.yaml
        #[arg(short, long)]
        config: PathBuf,

        /// Path to RFDB unix socket
        #[arg(short, long)]
        socket: Option<PathBuf>,

        /// Number of parallel analysis jobs
        #[arg(short, long, default_value_t = num_cpus())]
        jobs: usize,

        /// Force re-analysis of all files (ignore mtime)
        #[arg(long)]
        force: bool,

        /// Number of parallel resolve workers (overrides auto-detection)
        #[arg(long)]
        resolve_jobs: Option<usize>,
    },
    /// Re-run resolution phase on an already-analyzed database
    Resolve {
        /// Path to grafema.config.yaml
        #[arg(short, long)]
        config: PathBuf,
        /// Path to RFDB unix socket
        #[arg(short, long)]
        socket: Option<PathBuf>,
        /// Number of parallel resolve workers (default: auto based on CPU count)
        #[arg(short, long)]
        jobs: Option<usize>,
    },
    /// Commit only DIRECTORY/FILE structural nodes (fast, skips analysis).
    /// Uses the discovered file list from the config to build the directory
    /// tree and upsert structural nodes into the existing RFDB.
    CommitDirs {
        /// Path to grafema.config.yaml
        #[arg(short, long)]
        config: PathBuf,
        /// Path to RFDB unix socket
        #[arg(short, long)]
        socket: Option<PathBuf>,
    },
    /// Run the hex-grid layout pipeline (pack → iswap → xswap).
    ///
    /// Two input modes (mutually exclusive):
    ///   * `--synthetic N` — generate a deterministic N-leaf fixture in memory.
    ///     Useful for benchmarks and visualisation dry-runs.
    ///   * `--socket <path> --config <path>` — load real graph data from a
    ///     live RFDB. MODULE nodes become leaves, MODULE→MODULE DEPENDS_ON
    ///     edges become layout edges.
    Layout {
        /// Use a synthetic tree of N leaves. Mutually exclusive with `--socket`.
        #[arg(long, conflicts_with = "socket")]
        synthetic: Option<usize>,

        /// Path to RFDB unix socket. Mutually exclusive with `--synthetic`.
        /// Requires `--config` so callers explicitly bind the layout run to
        /// a project; the config defaults wiring is intentionally out of scope
        /// for this step.
        #[arg(short, long, requires = "config")]
        socket: Option<PathBuf>,

        /// Path to grafema.config.yaml. Required when `--socket` is given.
        #[arg(short, long)]
        config: Option<PathBuf>,

        /// Skip iswap and xswap (raw pack only — fast, no optimisation).
        #[arg(long)]
        pack_only: bool,

        /// Random seed for synthetic tree generation. Same seed → identical
        /// output bytes.
        #[arg(long, default_value_t = 42)]
        seed: u64,

        /// Average edges per leaf (default 1.5× leaves).
        #[arg(long, default_value_t = 1.5)]
        edge_density: f32,

        /// Dump final coords + stats as pretty JSON to this file. Schema:
        /// `{ "coords": { "<path>": { "q": i32, "r": i32 }, ... }, "stats": {...} }`.
        #[arg(long)]
        dump_json: Option<PathBuf>,

        /// Write `LAYOUT_POSITION` edges back to RFDB after computing the layout.
        /// Each MODULE node gets one edge to a synthetic `HEX::<q>,<r>` id, with
        /// metadata `{"_source":"layout-pack"}`. Requires `--socket` (the layout
        /// must come from RFDB to be committable). Ignored with `--synthetic`
        /// — a warning is printed and the commit is skipped.
        #[arg(long)]
        commit: bool,

        /// Print per-folder torn details in the validation report.
        #[arg(short, long)]
        verbose: bool,
    },
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Number of CPU cores available for resolve workers.
/// Reserves 1 core for the main thread / RFDB / OS.
///
/// Memory-aware: each resolve worker uses ~5GB RSS on large graphs
/// (context nodes like SCOPE, PARAM, CLASS are broadcast to ALL workers).
/// On memory-constrained VMs (e.g., 16GB with RFDB using 3GB), this
/// limits to 1-2 workers to prevent OOM.
///
/// NOTE: Currently unused — JS resolution uses per-file streaming (1 worker).
/// Kept for potential multi-worker use by other languages.
#[allow(dead_code)]
fn resolve_worker_count() -> usize {
    let cpus = num_cpus();
    let cpu_based = std::cmp::min(7, if cpus > 1 { cpus - 1 } else { 1 });

    // Memory-aware: each resolve worker uses ~5GB (context nodes broadcast),
    // RFDB ~3GB, OS+orchestrator ~1GB headroom
    let available_gb = available_memory_gb();
    let mem_based = if available_gb > 4 {
        ((available_gb - 4) / 5) as usize // 4GB reserved, 5GB per worker
    } else {
        1
    };

    let count = cpu_based.min(mem_based).max(1);
    if count < cpu_based {
        tracing::info!(
            cpu_workers = cpu_based,
            mem_workers = count,
            available_gb = available_gb,
            "Worker count limited by available memory"
        );
    }
    count
}

/// Detect available system memory in GB.
///
/// Linux: reads MemAvailable from /proc/meminfo (accounts for caches/buffers).
/// macOS: reads total physical memory via sysctl hw.memsize.
/// Fallback: 16GB (conservative default).
#[allow(dead_code)]
fn available_memory_gb() -> u64 {
    // Linux: /proc/meminfo MemAvailable (available, not total)
    if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
        for line in content.lines() {
            if line.starts_with("MemAvailable:") {
                if let Some(kb_str) = line.split_whitespace().nth(1) {
                    if let Ok(kb) = kb_str.parse::<u64>() {
                        return kb / 1024 / 1024; // KB → GB
                    }
                }
            }
        }
    }

    // macOS: sysctl hw.memsize (total physical memory)
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
        {
            if let Ok(bytes_str) = std::str::from_utf8(&output.stdout) {
                if let Ok(bytes) = bytes_str.trim().parse::<u64>() {
                    return bytes / 1024 / 1024 / 1024;
                }
            }
        }
    }

    // Default: assume 16GB
    16
}

/// Resolve the URI authority for grafema:// URIs.
///
/// Priority:
/// 1. Explicit config: cfg.authority
/// 2. Git remote: parse `git remote get-url origin` → "github.com/owner/repo"
/// 3. Fallback: "localhost/{basename(root)}"
fn resolve_authority(cfg: &config::AnalyzerConfig) -> String {
    if let Some(ref auth) = cfg.authority {
        return auth.clone();
    }

    // Try git remote
    if let Ok(output) = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&cfg.root)
        .output()
    {
        if output.status.success() {
            let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(authority) = parse_git_remote_authority(&url) {
                return authority;
            }
        }
    }

    // Fallback: localhost/basename
    let basename = cfg.root.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    format!("localhost/{basename}")
}

/// Parse git remote URL to authority format.
/// Supports: git@github.com:owner/repo.git, https://github.com/owner/repo.git
fn parse_git_remote_authority(url: &str) -> Option<String> {
    // SSH format: git@github.com:owner/repo.git
    if let Some(rest) = url.strip_prefix("git@") {
        let colon_pos = rest.find(':')?;
        let host = &rest[..colon_pos];
        let path = rest[colon_pos + 1..].trim_end_matches(".git");
        return Some(format!("{host}/{path}"));
    }

    // HTTPS format: https://github.com/owner/repo.git
    if url.starts_with("https://") || url.starts_with("http://") {
        let without_scheme = url.split("://").nth(1)?;
        let trimmed = without_scheme.trim_end_matches(".git").trim_end_matches('/');
        return Some(trimmed.to_string());
    }

    None
}

/// Build a map from file path to MODULE semantic ID from RFDB.
async fn build_file_to_module_map(rfdb: &mut rfdb::RfdbClient) -> HashMap<String, String> {
    let module_nodes = rfdb.query_nodes_by_type("MODULE").await.unwrap_or_default();
    module_nodes
        .into_iter()
        .filter_map(|n| {
            let file = n.file?;
            let sid = n.semantic_id.or(Some(n.id))?;
            Some((file, sid))
        })
        .collect()
}

/// Validate, stamp, tag virtual nodes, and commit a resolution output to RFDB.
async fn commit_resolve_output(
    output: &mut plugin::PluginOutput,
    name: &str,
    generation: u64,
    rfdb: &mut rfdb::RfdbClient,
) -> anyhow::Result<()> {
    plugin::validate_plugin_output(output)?;
    plugin::stamp_metadata(output, name, generation);
    tag_virtual_nodes(output, name);
    let files: Vec<String> = output
        .nodes
        .iter()
        .filter_map(|n| n.file.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    rfdb.commit_batch(&files, &output.nodes, &output.edges, true)
        .await
        .context(format!("Failed to commit {name} output"))?;
    tracing::info!(
        plugin = name,
        nodes = output.nodes.len(),
        edges = output.edges.len(),
        "Resolution step complete"
    );
    Ok(())
}

/// Detect which languages are present in the RFDB graph by inspecting MODULE node file extensions.
async fn detect_languages_in_db(rfdb: &mut rfdb::RfdbClient) -> HashSet<config::Language> {
    let module_nodes = rfdb.query_nodes_by_type("MODULE").await.unwrap_or_default();
    let mut langs = HashSet::new();
    for node in &module_nodes {
        if let Some(ref file) = node.file {
            if let Some(lang) = config::detect_language(std::path::Path::new(file)) {
                langs.insert(lang);
            }
        }
    }
    langs
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Analyze {
            config: config_path,
            socket,
            jobs,
            force,
            resolve_jobs: _resolve_jobs,
        } => {
            let cfg = config::load(&config_path)?.with_defaults();

            // Resolve RFDB socket path: CLI flag > config > default
            let socket_path = socket
                .or(cfg.rfdb_socket.clone())
                .unwrap_or_else(|| PathBuf::from("/tmp/rfdb.sock"));

            // Discover workspace packages from services config
            let ws_packages_raw = config::discover_workspace_packages(&cfg.root, &cfg.services);
            let mut ws_packages: Vec<plugin::WorkspacePackageWire> = ws_packages_raw
                .iter()
                .map(|p| plugin::WorkspacePackageWire {
                    name: p.name.clone(),
                    entry_point: p.entry_point.clone(),
                    package_dir: p.package_dir.clone(),
                })
                .collect();

            // Expand aliases into virtual workspace packages.
            // E.g., alias "jodit/esm" → "jodit/src" creates a virtual package
            // so `import from 'jodit/esm/config'` resolves to `jodit/src/config.ts`.
            for (alias_prefix, target_dir) in &cfg.aliases {
                let index_candidates = ["index.ts", "index.tsx", "index.js"];
                let entry = index_candidates
                    .iter()
                    .map(|f| format!("{}/{}", target_dir, f))
                    .find(|p| cfg.root.join(p).exists())
                    .unwrap_or_else(|| format!("{}/index.ts", target_dir));

                tracing::info!(
                    alias = %alias_prefix,
                    target = %target_dir,
                    entry = %entry,
                    "Alias expanded to virtual workspace package"
                );
                ws_packages.push(plugin::WorkspacePackageWire {
                    name: alias_prefix.clone(),
                    entry_point: entry,
                    package_dir: target_dir.clone(),
                });
            }

            if !ws_packages.is_empty() {
                tracing::info!(
                    count = ws_packages.len(),
                    "Workspace packages for cross-package resolution (including aliases)"
                );
            }

            tracing::info!(
                config = %config_path.display(),
                socket = %socket_path.display(),
                jobs = jobs,
                force = force,
                "Starting analysis"
            );

            // 0. Create profiler
            let profile_path = cfg.root.join(".grafema").join("analysis-profile.jsonl");
            let prof = profiler::Profiler::new(&profile_path).ok();
            macro_rules! profile {
                ($event:expr $(, $k:expr => $v:expr)*) => {
                    if let Some(ref p) = prof {
                        p.event($event, &[$(($k, &$v.to_string())),*]);
                    }
                };
            }
            profile!("analysis_start", "config" => config_path.display());

            let pipeline_start = std::time::Instant::now();

            // 1. Discover files
            let discovery_start = std::time::Instant::now();
            let files = discovery::discover(&cfg)?;
            let discovery_ms = discovery_start.elapsed().as_millis() as u64;
            tracing::info!(count = files.len(), "Discovered files");
            profile!("files_discovered", "count" => files.len(), "duration_ms" => discovery_ms);

            if files.is_empty() {
                tracing::warn!("No files matched include patterns");
                return Ok(());
            }

            // 2. Connect to RFDB
            let mut rfdb = rfdb::RfdbClient::connect(&socket_path)
                .await
                .with_context(|| format!("Failed to connect to RFDB at {}", socket_path.display()))?;

            let db_name = "default";
            rfdb.create_database(db_name, false).await?;
            rfdb.open_database(db_name, "rw").await?;
            tracing::info!(db = db_name, "Connected to RFDB");

            // 3. Set up generation tracker and filter changed files
            let filter_start = std::time::Instant::now();
            let tracker_path = cfg.root.join(".grafema").join("gen-tracker.json");
            let mut gen_tracker = gc::GenerationTracker::load(&tracker_path);
            let generation = gen_tracker.bump();
            let (changed_files, unchanged_files) =
                gc::filter_changed_files(&files, &gen_tracker, force)?;
            let filter_ms = filter_start.elapsed().as_millis() as u64;

            tracing::info!(
                changed = changed_files.len(),
                skipped = unchanged_files.len(),
                generation = generation,
                "Filtered files for analysis"
            );

            if changed_files.is_empty() {
                tracing::info!("All files up to date, nothing to analyze");
                return Ok(());
            }

            // 3b. Partition by language
            let (js_files, hs_files, rs_files, java_files, kotlin_files, py_files, go_files, cpp_files, swift_files, objc_files, beam_files, rb_files) = config::partition_by_language(&changed_files);
            tracing::info!(
                js = js_files.len(),
                haskell = hs_files.len(),
                rust = rs_files.len(),
                java = java_files.len(),
                kotlin = kotlin_files.len(),
                python = py_files.len(),
                go = go_files.len(),
                cpp = cpp_files.len(),
                swift = swift_files.len(),
                objc = objc_files.len(),
                beam = beam_files.len(),
                ruby = rb_files.len(),
                "Partitioned files by language"
            );

            // 3c. Verify binary freshness (source hash check)
            {
                let mut binaries_to_check = Vec::new();
                if !js_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.js_path());
                    binaries_to_check.push(cfg.analyzers.js_resolve_path());
                }
                if !hs_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.haskell_path());
                    binaries_to_check.push(cfg.analyzers.haskell_resolve_path());
                }
                if !rs_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.rust_path());
                    binaries_to_check.push(cfg.analyzers.rust_resolve_path());
                }
                if !java_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.java_path());
                    binaries_to_check.push(cfg.analyzers.java_resolve_path());
                }
                if !kotlin_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.kotlin_path());
                    binaries_to_check.push(cfg.analyzers.kotlin_resolve_path());
                }
                if !go_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.go_path());
                    binaries_to_check.push(cfg.analyzers.go_resolve_path());
                }
                if !cpp_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.cpp_path());
                    binaries_to_check.push(cfg.analyzers.cpp_resolve_path());
                }
                if !swift_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.swift_parser_path());
                    binaries_to_check.push(cfg.analyzers.swift_path());
                    binaries_to_check.push(cfg.analyzers.swift_resolve_path());
                }
                if !objc_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.objc_parser_path());
                    binaries_to_check.push(cfg.analyzers.objc_path());
                }
                if !beam_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.beam_path());
                    binaries_to_check.push(cfg.analyzers.beam_resolve_path());
                }

                for binary in &binaries_to_check {
                    if let Err(msg) = source_hash::verify_binary(binary, &cfg.root) {
                        anyhow::bail!("{msg}");
                    }
                }
            }

            // 4. Streaming double-buffer analysis pipeline.
            //
            //    ALL languages analyze in parallel, sending results through ONE
            //    bounded mpsc channel. A single receiver batches INGEST_BATCH_SIZE
            //    results and commits to RFDB while analysis continues filling the
            //    channel. Memory stays proportional to batch size, not project size.
            //
            //    JS/TS: per-file streaming (results sent as each file completes)
            //    Other: per-language streaming (results forwarded after pool completes)
            let size_limits = config::SizeLimits::from_config(&cfg);
            const INGEST_BATCH_SIZE: usize = 20;
            let analysis_timer = std::time::Instant::now();
            let mut total_nodes = 0usize;
            let mut total_edges = 0usize;
            let mut total_errors = 0usize;
            let mut total_files_committed = 0usize;
            let root_str = cfg.root.display().to_string();
            let effects_db_dir = cfg.root.join("effects-db");
            let effects_db_path: Option<String> = if effects_db_dir.exists() {
                Some(effects_db_dir.to_string_lossy().to_string())
            } else {
                None
            };
            let authority = resolve_authority(&cfg);
            let total_files = files.len();

            // Helper: prepare and commit a chunk of analysis results to RFDB.
            // Takes ownership → results are freed after commit.
            async fn ingest_chunk(
                mut results: Vec<analyzer::AnalysisResult>,
                rfdb: &mut rfdb::RfdbClient,
                root_str: &str,
                authority: &str,
                generation: u64,
                global_progress: usize,
                total_files: usize,
            ) -> anyhow::Result<(usize, usize, usize)> {
                let mut nodes_total = 0usize;
                let mut edges_total = 0usize;
                let mut errors_total = 0usize;

                // Convert byte offsets → line:column for JS/TS files (Haskell
                // js-analyzer outputs byte offsets, not line numbers).
                // Must happen BEFORE relativize_paths since we need absolute paths.
                for result in &mut results {
                    if let Some(ref mut analysis) = result.analysis {
                        if analyzer::is_js_ts_file(&result.file) {
                            analysis.convert_byte_offsets_to_lines(&result.file);
                        }
                        analysis.relativize_paths(root_str);
                        analysis.ensure_function_contains_edges();
                        analysis.ensure_function_scope_edges();
                        analysis.ensure_exported_flags();
                        analysis.to_uri_format(authority);
                    }
                }

                let mut batch_nodes: Vec<rfdb::WireNode> = Vec::new();
                let mut batch_edges: Vec<rfdb::WireEdge> = Vec::new();
                let mut batch_files: Vec<String> = Vec::new();

                for result in &results {
                    if !result.errors.is_empty() {
                        errors_total += result.errors.len();
                        for err in &result.errors {
                            tracing::error!(file = %result.file.display(), "{err}");
                        }
                    }

                    if let Some(ref analysis) = result.analysis {
                        let mut wire_nodes = analyzer::to_wire_nodes(analysis);
                        let mut wire_edges = analyzer::to_wire_edges(analysis);

                        for node in &mut wire_nodes {
                            gc::stamp_node_metadata(&mut node.metadata, generation, "analyzer");
                        }
                        for edge in &mut wire_edges {
                            gc::stamp_edge_metadata(&mut edge.metadata, generation, "analyzer");
                        }

                        nodes_total += wire_nodes.len();
                        edges_total += wire_edges.len();

                        batch_files.push(analysis.file.clone());
                        batch_nodes.extend(wire_nodes);
                        batch_edges.extend(wire_edges);
                    }

                    // Persist METRIC nodes for per-file performance data
                    {
                        let abs_file = result.file.display().to_string();
                        let root_prefix = if root_str.ends_with('/') {
                            root_str.to_string()
                        } else {
                            format!("{root_str}/")
                        };
                        let rel_file = abs_file.strip_prefix(&root_prefix)
                            .unwrap_or(&abs_file);

                        let (mut metric_nodes, mut metric_edges) =
                            analyzer::metrics_to_wire(&result.metrics, rel_file, authority);

                        for node in &mut metric_nodes {
                            gc::stamp_node_metadata(&mut node.metadata, generation, "orchestrator-metrics");
                        }
                        for edge in &mut metric_edges {
                            gc::stamp_edge_metadata(&mut edge.metadata, generation, "orchestrator-metrics");
                        }

                        nodes_total += metric_nodes.len();
                        edges_total += metric_edges.len();

                        batch_nodes.extend(metric_nodes);
                        batch_edges.extend(metric_edges);
                    }

                    // Persist ISSUE nodes for analysis problems (oversized files, parse errors, etc.)
                    if !result.issues.is_empty() {
                        let abs_file = result.file.display().to_string();
                        let root_prefix = if root_str.ends_with('/') {
                            root_str.to_string()
                        } else {
                            format!("{root_str}/")
                        };
                        let rel_file = abs_file.strip_prefix(&root_prefix)
                            .unwrap_or(&abs_file);

                        let include_module_stub = result.analysis.is_none();
                        let (mut issue_nodes, mut issue_edges) =
                            analyzer::issues_to_wire(&result.issues, rel_file, authority, include_module_stub);

                        for node in &mut issue_nodes {
                            gc::stamp_node_metadata(&mut node.metadata, generation, "analyzer");
                        }
                        for edge in &mut issue_edges {
                            gc::stamp_edge_metadata(&mut edge.metadata, generation, "analyzer");
                        }

                        nodes_total += issue_nodes.len();
                        edges_total += issue_edges.len();

                        // Ensure file is in batch for RFDB file-scoped deletion
                        if result.analysis.is_none() {
                            batch_files.push(rel_file.to_string());
                        }
                        batch_nodes.extend(issue_nodes);
                        batch_edges.extend(issue_edges);
                    }
                }

                if !batch_files.is_empty() {
                    tracing::info!(
                        progress = format!("{}/{}", global_progress, total_files),
                        files = batch_files.len(),
                        nodes = batch_nodes.len(),
                        edges = batch_edges.len(),
                        "Committing batch to RFDB"
                    );
                    rfdb.commit_batch(&batch_files, &batch_nodes, &batch_edges, true)
                        .await
                        .context("Failed to commit analysis batch")?;
                }

                Ok((nodes_total, edges_total, errors_total))
            }

            // Shared channel for all languages. Bounded = backpressure when
            // ingestion is slower than analysis.
            let (tx, mut rx) =
                tokio::sync::mpsc::channel::<analyzer::AnalysisResult>(INGEST_BATCH_SIZE * 2);

            // Save JS file count before moving into streaming task
            let js_file_count = js_files.len();

            // Macro: spawn a language's analysis in background, forward results
            // through the shared channel. Clones the file list (fine for non-JS
            // languages which typically have <1K files).
            macro_rules! spawn_analysis {
                ($files:expr, $lang:expr, $analyze_fn:expr) => {
                    if !$files.is_empty() {
                        tracing::info!(count = $files.len(), concat!("Analyzing ", $lang, " files"));
                        let tx = tx.clone();
                        let files_vec: Vec<std::path::PathBuf> = $files.to_vec();
                        let analyzers = cfg.analyzers.clone();
                        let jobs = jobs;
                        let limits = size_limits;
                        tokio::spawn(async move {
                            let results = $analyze_fn(&files_vec, jobs, &analyzers, limits).await;
                            for r in results {
                                if tx.send(r).await.is_err() { break; }
                            }
                        });
                    }
                };
            }

            // 4a. JS/TS — per-file streaming (most critical for 14K+ file projects)
            if js_file_count > 0 {
                tracing::info!(count = js_file_count, "Analyzing JS/TS files");
                let tx_js = tx.clone();
                let js_analyzer_path = cfg.analyzers.js_path();
                let js_jobs = jobs;
                let js_limits = size_limits;
                tokio::spawn(async move {
                    analyzer::analyze_js_files_streaming(
                        js_files, js_jobs, js_analyzer_path, tx_js, js_limits,
                    )
                    .await;
                });
            }

            // 4b–4k. All other languages — pool-based analysis, results forwarded
            spawn_analysis!(hs_files, "Haskell", analyzer::analyze_haskell_files_parallel_pooled);
            spawn_analysis!(rs_files, "Rust", grafema_orchestrator::rust_analyzer::analyze_rust_files_native);
            spawn_analysis!(java_files, "Java", analyzer::analyze_java_files_parallel_pooled);
            spawn_analysis!(kotlin_files, "Kotlin", analyzer::analyze_kotlin_files_parallel_pooled);
            spawn_analysis!(py_files, "Python", analyzer::analyze_python_files_parallel_pooled);
            spawn_analysis!(go_files, "Go", analyzer::analyze_go_files_parallel_pooled);
            spawn_analysis!(swift_files, "Swift", analyzer::analyze_swift_files_parallel_pooled);
            spawn_analysis!(objc_files, "Obj-C", analyzer::analyze_objc_files_parallel_pooled);
            spawn_analysis!(beam_files, "BEAM", analyzer::analyze_beam_files_parallel_pooled);
            #[cfg(feature = "ruby")]
            spawn_analysis!(rb_files, "Ruby", grafema_orchestrator::ruby_analyzer::analyze_ruby_files_native);

            // C++ needs compile_commands — handle separately
            if !cpp_files.is_empty() {
                tracing::info!(count = cpp_files.len(), "Analyzing C/C++ files");

                let compile_commands = {
                    let search_dirs = [
                        cfg.root.clone(),
                        cfg.root.join("build"),
                        cfg.root.join("cmake-build-debug"),
                        cfg.root.join("cmake-build-release"),
                        cfg.root.join("out"),
                        cfg.root.join("_build"),
                    ];
                    let mut db = None;
                    for dir in &search_dirs {
                        let cc_path = dir.join("compile_commands.json");
                        if cc_path.is_file() {
                            match grafema_orchestrator::cpp_parser::CompileCommandsDb::load(&cc_path) {
                                Ok(loaded) => {
                                    tracing::info!(
                                        path = %cc_path.display(),
                                        "Loaded compile_commands.json"
                                    );
                                    db = Some(loaded);
                                    break;
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        path = %cc_path.display(),
                                        "Failed to load compile_commands.json: {e}"
                                    );
                                }
                            }
                        }
                    }
                    db
                };

                let tx_cpp = tx.clone();
                let cpp_files_vec: Vec<PathBuf> = cpp_files.to_vec();
                let cpp_analyzers = cfg.analyzers.clone();
                let cpp_jobs = jobs;
                let cpp_limits = size_limits;
                tokio::spawn(async move {
                    let results = analyzer::analyze_cpp_files_parallel_pooled(
                        &cpp_files_vec,
                        cpp_jobs,
                        &cpp_analyzers,
                        compile_commands.as_ref(),
                        cpp_limits,
                    )
                    .await;
                    for r in results {
                        if tx_cpp.send(r).await.is_err() { break; }
                    }
                });
            }

            // Drop the original sender — channel closes when ALL language tasks complete
            drop(tx);

            // Single receiver: batch results from all languages and commit to RFDB.
            // Analysis and ingestion run in parallel (double-buffer).
            let mut batch = Vec::with_capacity(INGEST_BATCH_SIZE);
            let mut batch_idx: usize = 0;
            let mut rfdb_commit_total_ms: u128 = 0;
            let mut batch_commit_latencies: Vec<u128> = Vec::new();
            while let Some(mut result) = rx.recv().await {
                // Compute semantic density metrics from analysis nodes
                result.metrics.fill_density(&result.analysis);
                // Emit per-file profiler event
                let m = &result.metrics;
                let file_str = result.file.display().to_string();
                profile!("file_analyzed",
                    "file" => file_str,
                    "file_size_bytes" => m.file_size_bytes,
                    "ast_size_bytes" => m.ast_size_bytes,
                    "parse_ms" => m.parse_ms,
                    "analyze_ms" => m.analyze_ms,
                    "total_ms" => m.total_ms,
                    "node_count" => m.node_count,
                    "edge_count" => m.edge_count,
                    "decl_count" => m.decl_count,
                    "ref_count" => m.ref_count,
                    "call_count" => m.call_count,
                    "prop_count" => m.prop_count
                );
                batch.push(result);
                if batch.len() >= INGEST_BATCH_SIZE {
                    let full_batch = std::mem::replace(
                        &mut batch,
                        Vec::with_capacity(INGEST_BATCH_SIZE),
                    );
                    let batch_len = full_batch.len();
                    let commit_start = std::time::Instant::now();
                    let (n, e, err) = ingest_chunk(
                        full_batch,
                        &mut rfdb,
                        &root_str,
                        &authority,
                        generation,
                        total_files_committed + batch_len,
                        total_files,
                    )
                    .await?;
                    let commit_ms = commit_start.elapsed().as_millis();
                    rfdb_commit_total_ms += commit_ms;
                    batch_commit_latencies.push(commit_ms);
                    profile!("batch_committed",
                        "batch_index" => batch_idx,
                        "files" => batch_len,
                        "nodes" => n,
                        "edges" => e,
                        "commit_ms" => commit_ms
                    );
                    total_nodes += n;
                    total_edges += e;
                    total_errors += err;
                    total_files_committed += batch_len;
                    if batch_idx % 10 == 0 {
                        let bp = analyzer::read_backpressure_count();
                        if bp > 0 {
                            profile!("channel_backpressure", "blocked_count" => bp);
                        }
                    }
                    batch_idx += 1;
                }
            }
            // Flush remaining results
            if !batch.is_empty() {
                let batch_len = batch.len();
                let commit_start = std::time::Instant::now();
                let (n, e, err) = ingest_chunk(
                    batch,
                    &mut rfdb,
                    &root_str,
                    &authority,
                    generation,
                    total_files_committed + batch_len,
                    total_files,
                )
                .await?;
                let commit_ms = commit_start.elapsed().as_millis();
                rfdb_commit_total_ms += commit_ms;
                batch_commit_latencies.push(commit_ms);
                profile!("batch_committed",
                    "batch_index" => batch_idx,
                    "files" => batch_len,
                    "nodes" => n,
                    "edges" => e,
                    "commit_ms" => commit_ms
                );
                total_nodes += n;
                total_edges += e;
                total_errors += err;
                total_files_committed += batch_len;
                let bp = analyzer::read_backpressure_count();
                if bp > 0 {
                    profile!("channel_backpressure", "blocked_count" => bp);
                }
            }

            // NOTE: Do NOT flush/rebuild_indexes here. Analysis commits
            // tombstone resolution edges (via delete_node cascading to edges).
            // If we flush now, tombstones get persisted to the store before
            // resolution can clear them via add_edges. Resolution edges would
            // then be removed by compaction. Let compact() handle the flush.
            // V2 engine write buffers are queryable without flushing.
            //
            // EXPERIMENT RESULT (2026-03-17): Pre-resolve compact made everything
            // 2x SLOWER (174s→305s). Compact creates L1 segments with indexes, but
            // each resolve commit_batch writes to write buffer, invalidating the
            // edge_type_index. Queries then scan both L1 + write buffer, paying
            // double. The real fix is write-buffer-level indexes (HashMap by type)
            // that survive mutations, not L1 compaction.

            // RFDB commit aggregate statistics
            let (batch_count, p50_ms, p95_ms, p99_ms) = if !batch_commit_latencies.is_empty() {
                batch_commit_latencies.sort();
                let len = batch_commit_latencies.len();
                let p50 = batch_commit_latencies[len / 2];
                let p95 = batch_commit_latencies[(len * 95) / 100];
                let p99 = batch_commit_latencies[(len * 99) / 100];
                let total_commit_ms = batch_commit_latencies.iter().sum::<u128>();
                let avg_nodes_per_sec = if total_commit_ms > 0 {
                    (total_nodes as u128 * 1000) / total_commit_ms
                } else { 0 };
                let avg_edges_per_sec = if total_commit_ms > 0 {
                    (total_edges as u128 * 1000) / total_commit_ms
                } else { 0 };

                profile!("rfdb_commit_summary",
                    "batches" => len,
                    "total_ms" => total_commit_ms,
                    "p50_ms" => p50,
                    "p95_ms" => p95,
                    "p99_ms" => p99,
                    "avg_nodes_per_sec" => avg_nodes_per_sec,
                    "avg_edges_per_sec" => avg_edges_per_sec
                );
                (len as u64, p50 as u64, p95 as u64, p99 as u64)
            } else {
                (0u64, 0u64, 0u64, 0u64)
            };

            tracing::info!(
                nodes = total_nodes,
                edges = total_edges,
                errors = total_errors,
                "Analysis complete"
            );
            profile!("analysis_complete",
                "nodes" => total_nodes, "edges" => total_edges, "errors" => total_errors);

            // 6.5. Build DIRECTORY/FILE structural nodes
            let dirstruct_start = std::time::Instant::now();
            let root_prefix_for_dirs = if root_str.ends_with('/') {
                root_str.clone()
            } else {
                format!("{root_str}/")
            };
            let relative_files: Vec<String> = files.iter()
                .map(|p| {
                    let abs = p.display().to_string();
                    abs.strip_prefix(&root_prefix_for_dirs).unwrap_or(&abs).to_string()
                })
                .collect();
            let (dir_nodes, dir_edges, cleanup_files) = directory_nodes::build(&relative_files);
            if !dir_nodes.is_empty() {
                match rfdb.commit_batch(&cleanup_files, &dir_nodes, &dir_edges, false).await {
                    Ok(_) => {
                        tracing::info!(
                            dir_nodes = dir_nodes.len(),
                            dir_edges = dir_edges.len(),
                            duration_ms = dirstruct_start.elapsed().as_millis() as u64,
                            "Directory/file structure committed"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "Failed to commit directory structure (non-fatal)");
                    }
                }
            }

            // 7. Handle deleted files
            let deleted = gc::detect_deleted_files(&gen_tracker, &files);
            if !deleted.is_empty() {
                tracing::info!(count = deleted.len(), "Cleaning up deleted files");
                let root_prefix = if root_str.ends_with('/') {
                    root_str.clone()
                } else {
                    format!("{root_str}/")
                };
                for del_file in &deleted {
                    let abs_str = del_file.display().to_string();
                    let file_str = abs_str.strip_prefix(&root_prefix).unwrap_or(&abs_str).to_string();
                    rfdb.commit_batch(&[file_str], &[], &[], false).await?;
                }
            }

            // 7. Update mtime tracker for next incremental run
            gc::update_mtimes(&mut gen_tracker, &changed_files)?;
            if let Err(e) = gen_tracker.save(&tracker_path) {
                tracing::warn!("Failed to save generation tracker: {}", e);
            }

            let analysis_ms = analysis_timer.elapsed().as_millis() as u64;

            // Collect IMPORTS_FROM edges from all import resolvers for DEPENDS_ON derivation
            let resolve_timer = std::time::Instant::now();
            let mut all_imports_from_edges: Vec<(String, String)> = Vec::new();

            // Build file → MODULE semantic ID map from RFDB (full graph)
            let file_to_module = build_file_to_module_map(&mut rfdb).await;

            // 8. Run JS resolution with per-file streaming (build-index + resolve-file)
            if js_file_count > 0 {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolution: JS/TS (per-file streaming, 1 worker)...");
                profile!("js_resolve_start", "workers" => 1);

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    max_message_size: 200 * 1024 * 1024,
                    request_timeout: std::time::Duration::from_secs(300),
                    effects_db_path: effects_db_path.clone(),
                };

                match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(resolve_pool) => {
                        let handles = resolve_pool.acquire_all().await?;

                        let mut output = plugin::resolve_per_file(
                            &mut rfdb,
                            config::Language::JavaScript,
                            &handles[0],
                            &ws_packages,
                        ).await?;

                        // Extract IMPORTS_FROM edges for DEPENDS_ON derivation
                        for edge in &output.edges {
                            if edge.edge_type == "IMPORTS_FROM" {
                                all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                            }
                        }

                        commit_resolve_output(&mut output, "js-resolution", generation, &mut rfdb).await?;

                        // Second pass: graph-traversal resolvers (this.method() + CALL-based globals)
                        let second_pass = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::JavaScript],
                            &[("js-this-method-calls", &[]), ("runtime-call-globals", &[])],
                            &resolve_pool,
                        ).await.unwrap_or_default();
                        for (cmd, mut o) in second_pass {
                            let commit_name = match cmd.as_str() {
                                "js-this-method-calls" => "js-this-method-calls",
                                "runtime-call-globals" => "js-call-globals",
                                _ => &cmd,
                            };
                            commit_resolve_output(&mut o, commit_name, generation, &mut rfdb).await?;
                            profile!("resolve_cmd_complete", "language" => "js", "cmd" => commit_name,
                                "nodes" => o.nodes.len(), "edges" => o.edges.len(),
                                "duration_ms" => 0);
                        }

                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("js_resolve_complete",
                            "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                            "duration_ms" => lang_ms);
                        eprintln!("  Resolution: JS complete ({} edges, {:.1}s)",
                            output.edges.len(), lang_ms as f64 / 1000.0);

                        drop(handles);
                        resolve_pool.shutdown().await;
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to create resolve pool, skipping built-in resolution: {e}"
                        );
                    }
                }
            }

            // 8a. Run Haskell resolution (streaming)
            if !hs_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("haskell_resolve_start");
                let hs_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.haskell_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(hs_pool_config, 1) {
                    Ok(hs_pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Haskell],
                            &[("haskell-imports", &[]), ("haskell-local-refs", &[]), ("haskell-local-calls", &[]), ("haskell-cross-module-calls", &[]), ("haskell-globals", &[])],
                            &hs_pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            let commit_name = match cmd.as_str() {
                                "haskell-imports" => "haskell-import-resolution",
                                "haskell-local-calls" => "haskell-local-calls",
                                "haskell-cross-module-calls" => "haskell-cross-module-calls",
                                "haskell-globals" => "haskell-runtime-globals",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "haskell", "cmd" => commit_name,
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        hs_pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("haskell_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to create Haskell resolve pool: {e}");
                    }
                }
            }

            // 8b. Run Rust resolution (streaming)
            if !rs_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("rust_resolve_start");
                let rs_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.rust_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(rs_pool_config, 1) {
                    Ok(rs_pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Rust],
                            &[("rust-imports", &[]), ("rust-calls", &[]), ("rust-cross-methods", &[]), ("rust-trait-resolve", &[]), ("rust-globals", &[])],
                            &rs_pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            let commit_name = match cmd.as_str() {
                                "rust-imports" => "rust-import-resolution",
                                "rust-calls"   => "rust-call-resolution",
                                "rust-cross-methods" => "rust-cross-method-calls",
                                "rust-trait-resolve" => "rust-trait-resolution",
                                "rust-globals" => "rust-runtime-globals",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "rust", "cmd" => commit_name,
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        rs_pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("rust_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to create Rust resolve pool: {e}");
                    }
                }
            }

            // 8c. Run Java resolution (streaming)
            if !java_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("java_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.java_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Java], &[("java-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "java-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "java", "cmd" => "java-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("java_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Java resolve pool: {e}"),
                }
            }

            // 8d. Run Kotlin resolution (streaming)
            if !kotlin_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("kotlin_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.kotlin_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Kotlin], &[("kotlin-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "kotlin-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "kotlin", "cmd" => "kotlin-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("kotlin_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Kotlin resolve pool: {e}"),
                }
            }

            // 8e. Run Python resolution (streaming)
            if !py_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("python_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.python_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Python], &[("python-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "python-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "python", "cmd" => "python-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("python_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Python resolve pool: {e}"),
                }
            }

            // 8f. Run Go resolution (streaming)
            if !go_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("go_resolve_start");
                let go_module_path = config::discover_go_module_path(&cfg.root);
                let go_ws_packages: Vec<plugin::WorkspacePackageWire> = go_module_path
                    .map(|mp| vec![plugin::WorkspacePackageWire {
                        name: mp.clone(),
                        entry_point: String::new(),
                        package_dir: cfg.root.display().to_string(),
                    }])
                    .unwrap_or_default();

                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.go_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Go], &[("go-all", &go_ws_packages)], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "go-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "go", "cmd" => "go-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("go_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Go resolve pool: {e}"),
                }
            }

            // 8g. Run Swift resolution (streaming)
            if !swift_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("swift_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.swift_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Swift], &[("swift-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "swift-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "swift", "cmd" => "swift-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("swift_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Swift resolve pool: {e}"),
                }
            }

            // 8h. Run Apple cross-language resolution (streaming, Swift + Obj-C)
            if !swift_files.is_empty() && !objc_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("apple_cross_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.apple_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Swift, config::Language::ObjectiveC],
                            &[("apple-cross-all", &[])],
                            &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            commit_resolve_output(&mut output, "apple-cross-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "apple-cross", "cmd" => "apple-cross-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("apple_cross_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Apple cross-resolve pool: {e}"),
                }
            }

            // 8i. Run JVM cross-language resolution (streaming, Java + Kotlin)
            if !java_files.is_empty() && !kotlin_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("jvm_cross_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.jvm_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Java, config::Language::Kotlin],
                            &[("jvm-cross-all", &[])],
                            &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "jvm-cross-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "jvm-cross", "cmd" => "jvm-cross-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("jvm_cross_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create JVM cross-resolve pool: {e}"),
                }
            }

            // 8j. Run C/C++ resolution (streaming)
            if !cpp_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("cpp_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.cpp_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Cpp], &[("cpp-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "cpp-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "cpp", "cmd" => "cpp-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("cpp_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create C/C++ resolve pool: {e}"),
                }
            }

            // 8k. Run BEAM resolution (streaming)
            if !beam_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("beam_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.beam_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Beam],
                            &[
                                ("beam-imports", &[]),
                                ("beam-local-refs", &[]),
                                ("beam-runtime-globals", &[]),
                                ("beam-behaviours", &[]),
                                ("beam-protocols", &[]),
                                // REG-1098 W6: resolve wrapper calls into virtual effect edges
                                // (runs after beam-local-refs so CALLS edges exist for walking)
                                ("beam-wrapper-resolve", &[]),
                                // REG-1098 W6.5: upgrade coarse SENDS_TO→PROCESS into precise
                                // SENDS_MESSAGE / SELF_SCHEDULE edges to MESSAGE_TYPE clauses
                                // (needs wrapper-resolve first so virtual calls from wrappers are seen)
                                ("beam-message-types", &[]),
                                // GAP-C: close the PubSub delivery loop — emit PUBLISHES edges
                                // from broadcast CALLs to subscriber handle_info clauses by
                                // matching (pubsub_server, topic) + shape unification.
                                ("beam-pubsub-delivery", &[]),
                                // REG-1098 W9: emit ISSUE nodes for MessageFlow findings
                                // (runs last; reads the post-resolution node snapshot)
                                ("beam-message-findings", &[]),
                            ],
                            &pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            let commit_name = match cmd.as_str() {
                                "beam-imports" => "beam-import-resolution",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "beam", "cmd" => commit_name,
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("beam_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create BEAM resolve pool: {e}"),
                }
            }

            // 8l. Ruby resolution (embedded — no external binary)
            #[cfg(feature = "ruby")]
            if !rb_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("ruby_resolve_start");
                match ruby_resolver::resolve_ruby_imports(&mut rfdb, &root_str).await {
                    Ok(output) => {
                        for edge in &output.edges {
                            if edge.edge_type == "IMPORTS_FROM" {
                                all_imports_from_edges
                                    .push((edge.src.clone(), edge.dst.clone()));
                            }
                        }
                        if !output.edges.is_empty() {
                            rfdb.commit_batch(&[], &output.nodes, &output.edges, true)
                                .await
                                .context("Failed to commit Ruby resolution edges")?;
                        }
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("ruby_resolve_complete",
                            "edges" => output.edges.len(),
                            "duration_ms" => lang_ms);
                        tracing::info!(
                            edges = output.edges.len(),
                            duration_ms = lang_ms as u64,
                            "Ruby resolution complete"
                        );
                    }
                    Err(e) => tracing::warn!("Ruby resolution failed: {e}"),
                }
            }

            // 8m. Run user-defined plugins via DAG (if any non-default plugins configured)
            let user_plugins: Vec<_> = cfg
                .plugins
                .iter()
                .filter(|p| {
                    p.name != "js-import-resolution" && p.name != "runtime-globals"
                })
                .cloned()
                .collect();
            if !user_plugins.is_empty() {
                tracing::info!(count = user_plugins.len(), "Running user-defined plugins");

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                let resolve_pool = match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(pool) => Some(pool),
                    Err(e) => {
                        tracing::warn!("Failed to create resolve pool for user plugins: {e}");
                        None
                    }
                };

                let plugin_results = plugin::run_plugins_dag(
                    &user_plugins,
                    &mut rfdb,
                    &socket_path,
                    db_name,
                    generation,
                    resolve_pool.as_ref(),
                )
                .await?;

                if let Some(pool) = resolve_pool {
                    pool.shutdown().await;
                }

                for pr in &plugin_results {
                    if let Some(ref err) = pr.error {
                        tracing::error!(plugin = %pr.plugin_name, "{err}");
                    }
                }
            }

            let resolve_ms = resolve_timer.elapsed().as_millis() as u64;

            // 8m. Generate unresolved diagnostics
            let diagnostics_start = std::time::Instant::now();
            {
                // Query for unresolved CALL nodes (no outgoing CALLS edge)
                let unresolved_calls_query = r#"violation(X, Name, File) :- node(X, "CALL"), attr(X, "name", Name), attr(X, "file", File), \+ edge(X, _, "CALLS")."#;

                // Query for unresolved IMPORT_BINDING nodes (no outgoing IMPORTS_FROM edge)
                let unresolved_imports_query = r#"violation(X, Name, File) :- node(X, "IMPORT_BINDING"), attr(X, "name", Name), attr(X, "file", File), \+ edge(X, _, "IMPORTS_FROM")."#;

                let mut unresolved: Vec<(String, String, String)> = Vec::new();

                for query in [unresolved_calls_query, unresolved_imports_query] {
                    match rfdb.datalog_query(query).await {
                        Ok(results) => {
                            for r in results {
                                let x = r.bindings.get("X").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let name = r.bindings.get("Name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let file = r.bindings.get("File").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                if !x.is_empty() {
                                    unresolved.push((x, name, file));
                                }
                            }
                        }
                        Err(e) => tracing::warn!("Unresolved diagnostics query failed: {e}"),
                    }
                }

                if !unresolved.is_empty() {
                    let file_set: HashSet<String> = file_to_module.keys().cloned().collect();
                    let (mut diag_nodes, mut diag_edges) = analyzer::unresolved_diagnostics_to_wire(
                        &unresolved, &file_set, &authority,
                    );

                    // Stamp generation so ISSUE nodes are GC'd on next analyze
                    for node in &mut diag_nodes {
                        gc::stamp_node_metadata(&mut node.metadata, generation, "unresolved-diagnostics");
                    }
                    for edge in &mut diag_edges {
                        gc::stamp_edge_metadata(&mut edge.metadata, generation, "unresolved-diagnostics");
                    }

                    if !diag_nodes.is_empty() {
                        let diag_files = vec!["__grafema_virtual/unresolved-diagnostics".to_string()];
                        rfdb.commit_batch(&diag_files, &diag_nodes, &diag_edges, true)
                            .await
                            .context("Failed to commit unresolved diagnostics")?;

                        let external = diag_nodes.iter().filter(|n| {
                            n.metadata.as_ref().is_some_and(|m| m.contains("unresolved_external"))
                        }).count();
                        let internal = diag_nodes.iter().filter(|n| {
                            n.metadata.as_ref().is_some_and(|m| m.contains("unresolved_internal"))
                        }).count();

                        tracing::info!(
                            total = unresolved.len(),
                            external = external,
                            internal = internal,
                            "Unresolved diagnostics generated"
                        );
                    }
                }
            }

            let diagnostics_ms = diagnostics_start.elapsed().as_millis() as u64;

            // 9. Derive MODULE→MODULE DEPENDS_ON edges from IMPORTS_FROM
            let depends_on_start = std::time::Instant::now();
            profile!("depends_on_start", "imports_from_edges" => all_imports_from_edges.len());
            if !all_imports_from_edges.is_empty() {
                let mut depends_on_pairs: HashSet<(String, String)> = HashSet::new();

                // Pre-compute URI prefix for extracting file paths from grafema:// URIs
                let uri_prefix = format!("grafema://{authority}/");

                for (src_id, dst_id) in &all_imports_from_edges {
                    // Extract file path from semantic ID.
                    // URI format: "grafema://authority/path/to/file.ts#FRAGMENT" → "path/to/file.ts"
                    // Legacy format: "path/to/file.ts->TYPE->name" → "path/to/file.ts"
                    let src_file = if let Some(rest) = src_id.strip_prefix(&uri_prefix) {
                        rest.split('#').next().unwrap_or("")
                    } else {
                        src_id.split("->").next().unwrap_or("")
                    };
                    let dst_file = if let Some(rest) = dst_id.strip_prefix(&uri_prefix) {
                        rest.split('#').next().unwrap_or("")
                    } else {
                        dst_id.split("->").next().unwrap_or("")
                    };

                    if let (Some(src_mod), Some(dst_mod)) =
                        (file_to_module.get(src_file), file_to_module.get(dst_file))
                    {
                        if src_mod != dst_mod {
                            depends_on_pairs.insert((src_mod.clone(), dst_mod.clone()));
                        }
                    }
                }

                if !depends_on_pairs.is_empty() {
                    let metadata_json = format!(
                        r#"{{"_source":"module-dependencies","_generation":{generation}}}"#
                    );

                    let depends_on_wire_edges: Vec<rfdb::WireEdge> = depends_on_pairs
                        .iter()
                        .map(|(src, dst)| rfdb::WireEdge {
                            src: src.clone(),
                            dst: dst.clone(),
                            edge_type: "DEPENDS_ON".to_string(),
                            metadata: Some(metadata_json.clone()),
                        })
                        .collect();

                    rfdb.commit_batch(&[], &[], &depends_on_wire_edges, true)
                        .await
                        .context("Failed to commit DEPENDS_ON edges")?;

                    tracing::info!(
                        edges = depends_on_wire_edges.len(),
                        from_imports = all_imports_from_edges.len(),
                        "Module dependency edges derived"
                    );
                    profile!("depends_on_complete",
                        "edges" => depends_on_wire_edges.len(),
                        "from_imports" => all_imports_from_edges.len());
                }
            }
            let depends_on_ms = depends_on_start.elapsed().as_millis() as u64;

            // Compact to deduplicate segments after all commits.
            // This is needed because:
            // 1. Re-analyzed files create new segment versions alongside old ones.
            //    The superseded_node/edge_count in the engine corrects node_count()
            //    for edges that go through the delete+readd path.
            // 2. DEPENDS_ON and other derived edges are committed with empty
            //    changed_files (no deletion phase), so old segment versions
            //    accumulate. Compaction deduplicates these by (src,dst,type) key.
            //
            // For incremental analysis (few files changed), skip compaction and
            // only rebuild indexes — same pattern as `grafema resolve`. L0 segments
            // remain queryable; full compaction runs on next full analysis or when
            // L0 accumulation triggers it. This avoids O(total_graph) compaction
            // cost for small changes.
            let compact_start = std::time::Instant::now();
            profile!("compact_start", "analysis_nodes" => total_nodes, "analysis_edges" => total_edges);
            let is_incremental = changed_files.len() < files.len();
            if is_incremental {
                tracing::info!(
                    changed = changed_files.len(),
                    total = files.len(),
                    "Incremental analysis — skipping compaction, rebuilding indexes only"
                );
                rfdb.rebuild_indexes().await.context("Failed to rebuild indexes")?;
            } else {
                rfdb.compact().await.context("Failed to compact")?;
            }
            let compact_ms = compact_start.elapsed().as_millis();
            profile!("compact_complete", "duration_ms" => compact_ms, "incremental" => is_incremental);

            // 10. Emit pipeline-level phase metrics as METRIC nodes
            {
                let phase_metrics: Vec<(&str, &str, u64, &str)> = vec![
                    ("discovery",    "duration_ms",  discovery_ms,               "ms"),
                    ("filter",       "duration_ms",  filter_ms,                  "ms"),
                    ("analysis",     "duration_ms",  analysis_ms,                "ms"),
                    ("analysis",     "total_nodes",  total_nodes as u64,         "count"),
                    ("analysis",     "total_edges",  total_edges as u64,         "count"),
                    ("analysis",     "total_files",  changed_files.len() as u64, "count"),
                    ("rfdb_commit",  "total_ms",     rfdb_commit_total_ms as u64, "ms"),
                    ("rfdb_commit",  "p50_ms",       p50_ms,                     "ms"),
                    ("rfdb_commit",  "p95_ms",       p95_ms,                     "ms"),
                    ("rfdb_commit",  "p99_ms",       p99_ms,                     "ms"),
                    ("rfdb_commit",  "batches",      batch_count,                "count"),
                    ("resolve",      "duration_ms",  resolve_ms,                 "ms"),
                    ("diagnostics",  "duration_ms",  diagnostics_ms,             "ms"),
                    ("depends_on",   "duration_ms",  depends_on_ms,              "ms"),
                    ("compact",      "duration_ms",  compact_ms as u64,          "ms"),
                ];

                let (mut phase_nodes, phase_edges) =
                    analyzer::phase_metrics_to_wire(&phase_metrics, &authority);

                for node in &mut phase_nodes {
                    gc::stamp_node_metadata(&mut node.metadata, generation, "orchestrator-metrics");
                }

                if !phase_nodes.is_empty() {
                    // Synthetic files for tombstoning on re-analysis
                    let phase_files: Vec<String> = phase_nodes
                        .iter()
                        .filter_map(|n| n.file.clone())
                        .collect::<HashSet<_>>()
                        .into_iter()
                        .collect();
                    rfdb.commit_batch(&phase_files, &phase_nodes, &phase_edges, true)
                        .await
                        .context("Failed to commit phase metrics")?;
                    tracing::info!(
                        nodes = phase_nodes.len(),
                        "Phase metrics committed"
                    );
                }
            }

            // Phase timing summary
            let total_ms = pipeline_start.elapsed().as_millis() as u64;
            profile!("phase_summary",
                "discovery_ms" => discovery_ms,
                "filter_ms" => filter_ms,
                "analysis_ms" => analysis_ms,
                "rfdb_commit_ms" => rfdb_commit_total_ms,
                "resolve_ms" => resolve_ms,
                "diagnostics_ms" => diagnostics_ms,
                "depends_on_ms" => depends_on_ms,
                "compact_ms" => compact_ms,
                "total_ms" => total_ms
            );

            // 11. Summary
            println!(
                "Analyzed {} files ({} JS, {} Haskell, {} Rust, {} Java, {} Kotlin, {} Python, {} Go, {} C/C++, {} BEAM, {} skipped): {} nodes, {} edges, {} errors",
                changed_files.len(),
                js_file_count,
                hs_files.len(),
                rs_files.len(),
                java_files.len(),
                kotlin_files.len(),
                py_files.len(),
                go_files.len(),
                cpp_files.len(),
                beam_files.len(),
                unchanged_files.len(),
                total_nodes,
                total_edges,
                total_errors
            );
            profile!("analysis_complete_final",
                "files" => changed_files.len(), "nodes" => total_nodes,
                "edges" => total_edges, "errors" => total_errors);

            Ok(())
        }

        Commands::Resolve {
            config: config_path,
            socket,
            jobs: _jobs,
        } => {
            let cfg = config::load(&config_path)?.with_defaults();

            // Resolve RFDB socket path: CLI flag > config > default
            let socket_path = socket
                .or(cfg.rfdb_socket.clone())
                .unwrap_or_else(|| PathBuf::from("/tmp/rfdb.sock"));

            let effects_db_dir = cfg.root.join("effects-db");
            let effects_db_path: Option<String> = if effects_db_dir.exists() {
                Some(effects_db_dir.to_string_lossy().to_string())
            } else {
                None
            };

            // Discover workspace packages from services config
            let ws_packages_raw = config::discover_workspace_packages(&cfg.root, &cfg.services);
            let mut ws_packages: Vec<plugin::WorkspacePackageWire> = ws_packages_raw
                .iter()
                .map(|p| plugin::WorkspacePackageWire {
                    name: p.name.clone(),
                    entry_point: p.entry_point.clone(),
                    package_dir: p.package_dir.clone(),
                })
                .collect();

            // Expand aliases into virtual workspace packages
            for (alias_prefix, target_dir) in &cfg.aliases {
                let index_candidates = ["index.ts", "index.tsx", "index.js"];
                let entry = index_candidates
                    .iter()
                    .map(|f| format!("{}/{}", target_dir, f))
                    .find(|p| cfg.root.join(p).exists())
                    .unwrap_or_else(|| format!("{}/index.ts", target_dir));

                ws_packages.push(plugin::WorkspacePackageWire {
                    name: alias_prefix.clone(),
                    entry_point: entry,
                    package_dir: target_dir.clone(),
                });
            }

            tracing::info!(
                config = %config_path.display(),
                socket = %socket_path.display(),
                "Starting resolve-only pass"
            );

            let pipeline_start = std::time::Instant::now();

            // Connect to RFDB
            let mut rfdb = rfdb::RfdbClient::connect(&socket_path)
                .await
                .with_context(|| format!("Failed to connect to RFDB at {}", socket_path.display()))?;

            let db_name = "default";
            let open_resp = rfdb.open_database(db_name, "rw").await?;
            if open_resp.node_count == 0 {
                anyhow::bail!(
                    "Database '{}' has 0 nodes — run `grafema analyze` first before resolve",
                    db_name
                );
            }
            tracing::info!(
                db = db_name,
                nodes = open_resp.node_count,
                edges = open_resp.edge_count,
                "Connected to RFDB (resolve-only)"
            );

            let authority = resolve_authority(&cfg);
            let generation = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();

            // Detect which languages are present in the graph
            let detected_langs = detect_languages_in_db(&mut rfdb).await;
            tracing::info!(?detected_langs, "Languages detected in graph");

            // Build file → MODULE semantic ID map
            let file_to_module = build_file_to_module_map(&mut rfdb).await;

            let resolve_timer = std::time::Instant::now();
            let mut all_imports_from_edges: Vec<(String, String)> = Vec::new();

            // --- JS resolution (per-file streaming) ---
            if detected_langs.contains(&config::Language::JavaScript) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: JS/TS (per-file streaming, 1 worker)...");

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    max_message_size: 200 * 1024 * 1024,
                    request_timeout: std::time::Duration::from_secs(300),
                    effects_db_path: effects_db_path.clone(),
                };

                match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(resolve_pool) => {
                        let handles = resolve_pool.acquire_all().await?;

                        let mut output = plugin::resolve_per_file(
                            &mut rfdb,
                            config::Language::JavaScript,
                            &handles[0],
                            &ws_packages,
                        ).await?;

                        // Extract IMPORTS_FROM edges for DEPENDS_ON derivation
                        for edge in &output.edges {
                            if edge.edge_type == "IMPORTS_FROM" {
                                all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                            }
                        }

                        commit_resolve_output(&mut output, "js-resolution", generation, &mut rfdb).await?;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: JS complete ({} edges, {:.1}s)",
                            output.edges.len(), lang_ms as f64 / 1000.0);
                        tracing::info!(duration_ms = lang_ms, "JS resolve complete");

                        drop(handles);
                        resolve_pool.shutdown().await;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to create JS resolve pool: {e}");
                    }
                }
            }

            // --- Haskell resolution ---
            if detected_langs.contains(&config::Language::Haskell) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Haskell...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.haskell_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Haskell],
                            &[("haskell-imports", &[]), ("haskell-local-refs", &[]), ("haskell-local-calls", &[]), ("haskell-cross-module-calls", &[]), ("haskell-globals", &[])],
                            &pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let commit_name = match cmd.as_str() {
                                "haskell-imports" => "haskell-import-resolution",
                                "haskell-local-calls" => "haskell-local-calls",
                                "haskell-cross-module-calls" => "haskell-cross-module-calls",
                                "haskell-globals" => "haskell-runtime-globals",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Haskell complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Haskell resolve pool: {e}"),
                }
            }

            // --- Rust resolution ---
            if detected_langs.contains(&config::Language::Rust) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Rust...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.rust_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Rust],
                            &[("rust-imports", &[]), ("rust-calls", &[]), ("rust-cross-methods", &[]), ("rust-trait-resolve", &[]), ("rust-globals", &[])],
                            &pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let commit_name = match cmd.as_str() {
                                "rust-imports" => "rust-import-resolution",
                                "rust-calls"   => "rust-call-resolution",
                                "rust-cross-methods" => "rust-cross-method-calls",
                                "rust-trait-resolve" => "rust-trait-resolution",
                                "rust-globals" => "rust-runtime-globals",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Rust complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Rust resolve pool: {e}"),
                }
            }

            // --- Java resolution ---
            if detected_langs.contains(&config::Language::Java) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Java...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.java_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Java], &[("java-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "java-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Java complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Java resolve pool: {e}"),
                }
            }

            // --- Kotlin resolution ---
            if detected_langs.contains(&config::Language::Kotlin) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Kotlin...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.kotlin_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Kotlin], &[("kotlin-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "kotlin-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Kotlin complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Kotlin resolve pool: {e}"),
                }
            }

            // --- Python resolution ---
            if detected_langs.contains(&config::Language::Python) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Python...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.python_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Python], &[("python-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "python-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Python complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Python resolve pool: {e}"),
                }
            }

            // --- Go resolution ---
            if detected_langs.contains(&config::Language::Go) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Go...");
                let go_module_path = config::discover_go_module_path(&cfg.root);
                let go_ws_packages: Vec<plugin::WorkspacePackageWire> = go_module_path
                    .map(|mp| vec![plugin::WorkspacePackageWire {
                        name: mp.clone(),
                        entry_point: String::new(),
                        package_dir: cfg.root.display().to_string(),
                    }])
                    .unwrap_or_default();

                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.go_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Go], &[("go-all", &go_ws_packages)], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "go-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Go complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Go resolve pool: {e}"),
                }
            }

            // --- Swift resolution ---
            if detected_langs.contains(&config::Language::Swift) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Swift...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.swift_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Swift], &[("swift-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "swift-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Swift complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Swift resolve pool: {e}"),
                }
            }

            // --- Apple cross-language resolution (Swift + Obj-C) ---
            if detected_langs.contains(&config::Language::Swift)
                && detected_langs.contains(&config::Language::ObjectiveC)
            {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Apple cross-language...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.apple_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Swift, config::Language::ObjectiveC],
                            &[("apple-cross-all", &[])],
                            &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            commit_resolve_output(&mut output, "apple-cross-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Apple cross-language complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Apple cross-resolve pool: {e}"),
                }
            }

            // --- JVM cross-language resolution (Java + Kotlin) ---
            if detected_langs.contains(&config::Language::Java)
                && detected_langs.contains(&config::Language::Kotlin)
            {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: JVM cross-language...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.jvm_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Java, config::Language::Kotlin],
                            &[("jvm-cross-all", &[])],
                            &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "jvm-cross-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: JVM cross-language complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create JVM cross-resolve pool: {e}"),
                }
            }

            // --- C/C++ resolution ---
            if detected_langs.contains(&config::Language::Cpp) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: C/C++...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.cpp_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Cpp], &[("cpp-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "cpp-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: C/C++ complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create C/C++ resolve pool: {e}"),
                }
            }

            // --- BEAM resolution ---
            if detected_langs.contains(&config::Language::Beam) {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: BEAM...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.beam_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Beam],
                            &[
                                ("beam-imports", &[]),
                                ("beam-local-refs", &[]),
                                ("beam-runtime-globals", &[]),
                                ("beam-behaviours", &[]),
                                ("beam-protocols", &[]),
                                // REG-1098 W6: resolve wrapper calls into virtual effect edges
                                ("beam-wrapper-resolve", &[]),
                                // REG-1098 W6.5: precise CALL→MESSAGE_TYPE edges via shape unification
                                ("beam-message-types", &[]),
                                // GAP-C: PUBLISHES edges from broadcasts to subscriber handlers
                                ("beam-pubsub-delivery", &[]),
                                // REG-1098 W9: emit ISSUE nodes for MessageFlow findings
                                ("beam-message-findings", &[]),
                            ],
                            &pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let commit_name = match cmd.as_str() {
                                "beam-imports" => "beam-import-resolution",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: BEAM complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create BEAM resolve pool: {e}"),
                }
            }

            let resolve_ms = resolve_timer.elapsed().as_millis() as u64;

            // User-defined plugins
            let user_plugins: Vec<_> = cfg
                .plugins
                .iter()
                .filter(|p| {
                    p.name != "js-import-resolution" && p.name != "runtime-globals"
                })
                .cloned()
                .collect();
            if !user_plugins.is_empty() {
                tracing::info!(count = user_plugins.len(), "Running user-defined plugins");

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                let resolve_pool = match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(pool) => Some(pool),
                    Err(e) => {
                        tracing::warn!("Failed to create resolve pool for user plugins: {e}");
                        None
                    }
                };

                let plugin_results = plugin::run_plugins_dag(
                    &user_plugins,
                    &mut rfdb,
                    &socket_path,
                    db_name,
                    generation,
                    resolve_pool.as_ref(),
                )
                .await?;

                if let Some(pool) = resolve_pool {
                    pool.shutdown().await;
                }

                for pr in &plugin_results {
                    if let Some(ref err) = pr.error {
                        tracing::error!(plugin = %pr.plugin_name, "{err}");
                    }
                }
            }

            // Unresolved diagnostics
            let diagnostics_start = std::time::Instant::now();
            {
                let unresolved_calls_query = r#"violation(X, Name, File) :- node(X, "CALL"), attr(X, "name", Name), attr(X, "file", File), \+ edge(X, _, "CALLS")."#;
                let unresolved_imports_query = r#"violation(X, Name, File) :- node(X, "IMPORT_BINDING"), attr(X, "name", Name), attr(X, "file", File), \+ edge(X, _, "IMPORTS_FROM")."#;

                let mut unresolved: Vec<(String, String, String)> = Vec::new();

                for query in [unresolved_calls_query, unresolved_imports_query] {
                    match rfdb.datalog_query(query).await {
                        Ok(results) => {
                            for r in results {
                                let x = r.bindings.get("X").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let name = r.bindings.get("Name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let file = r.bindings.get("File").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                if !x.is_empty() {
                                    unresolved.push((x, name, file));
                                }
                            }
                        }
                        Err(e) => tracing::warn!("Unresolved diagnostics query failed: {e}"),
                    }
                }

                if !unresolved.is_empty() {
                    let file_set: HashSet<String> = file_to_module.keys().cloned().collect();
                    let (mut diag_nodes, mut diag_edges) = analyzer::unresolved_diagnostics_to_wire(
                        &unresolved, &file_set, &authority,
                    );

                    // Stamp generation so ISSUE nodes are GC'd on next analyze
                    for node in &mut diag_nodes {
                        gc::stamp_node_metadata(&mut node.metadata, generation, "unresolved-diagnostics");
                    }
                    for edge in &mut diag_edges {
                        gc::stamp_edge_metadata(&mut edge.metadata, generation, "unresolved-diagnostics");
                    }

                    if !diag_nodes.is_empty() {
                        let diag_files = vec!["__grafema_virtual/unresolved-diagnostics".to_string()];
                        rfdb.commit_batch(&diag_files, &diag_nodes, &diag_edges, true)
                            .await
                            .context("Failed to commit unresolved diagnostics")?;

                        let external = diag_nodes.iter().filter(|n| {
                            n.metadata.as_ref().is_some_and(|m| m.contains("unresolved_external"))
                        }).count();
                        let internal = diag_nodes.iter().filter(|n| {
                            n.metadata.as_ref().is_some_and(|m| m.contains("unresolved_internal"))
                        }).count();

                        tracing::info!(
                            total = unresolved.len(),
                            external = external,
                            internal = internal,
                            "Unresolved diagnostics generated"
                        );
                    }
                }
            }
            let diagnostics_ms = diagnostics_start.elapsed().as_millis() as u64;

            // Derive MODULE→MODULE DEPENDS_ON edges from IMPORTS_FROM
            let depends_on_start = std::time::Instant::now();
            if !all_imports_from_edges.is_empty() {
                let mut depends_on_pairs: HashSet<(String, String)> = HashSet::new();
                let uri_prefix = format!("grafema://{authority}/");

                for (src_id, dst_id) in &all_imports_from_edges {
                    let src_file = if let Some(rest) = src_id.strip_prefix(&uri_prefix) {
                        rest.split('#').next().unwrap_or("")
                    } else {
                        src_id.split("->").next().unwrap_or("")
                    };
                    let dst_file = if let Some(rest) = dst_id.strip_prefix(&uri_prefix) {
                        rest.split('#').next().unwrap_or("")
                    } else {
                        dst_id.split("->").next().unwrap_or("")
                    };

                    if let (Some(src_mod), Some(dst_mod)) =
                        (file_to_module.get(src_file), file_to_module.get(dst_file))
                    {
                        if src_mod != dst_mod {
                            depends_on_pairs.insert((src_mod.clone(), dst_mod.clone()));
                        }
                    }
                }

                if !depends_on_pairs.is_empty() {
                    let metadata_json = format!(
                        r#"{{"_source":"module-dependencies","_generation":{generation}}}"#
                    );

                    let depends_on_wire_edges: Vec<rfdb::WireEdge> = depends_on_pairs
                        .iter()
                        .map(|(src, dst)| rfdb::WireEdge {
                            src: src.clone(),
                            dst: dst.clone(),
                            edge_type: "DEPENDS_ON".to_string(),
                            metadata: Some(metadata_json.clone()),
                        })
                        .collect();

                    rfdb.commit_batch(&[], &[], &depends_on_wire_edges, true)
                        .await
                        .context("Failed to commit DEPENDS_ON edges")?;

                    tracing::info!(
                        edges = depends_on_wire_edges.len(),
                        from_imports = all_imports_from_edges.len(),
                        "Module dependency edges derived"
                    );
                }
            }
            let depends_on_ms = depends_on_start.elapsed().as_millis() as u64;

            // Skip compact during resolve to avoid OOM on memory-constrained VMs.
            // Resolution adds edges via virtual files — no segment dedup strictly
            // needed. Compact runs at the end of the next `grafema analyze`.
            // Instead, just flush write buffers so data is persisted to disk.
            let compact_start = std::time::Instant::now();
            rfdb.rebuild_indexes().await.context("Failed to flush after resolve")?;
            let compact_ms = compact_start.elapsed().as_millis();

            // Phase metrics (resolve-only subset)
            {
                let phase_metrics: Vec<(&str, &str, u64, &str)> = vec![
                    ("resolve",      "duration_ms",  resolve_ms,                 "ms"),
                    ("diagnostics",  "duration_ms",  diagnostics_ms,             "ms"),
                    ("depends_on",   "duration_ms",  depends_on_ms,              "ms"),
                    ("flush",        "duration_ms",  compact_ms as u64,          "ms"),
                ];

                let (mut phase_nodes, phase_edges) =
                    analyzer::phase_metrics_to_wire(&phase_metrics, &authority);

                for node in &mut phase_nodes {
                    gc::stamp_node_metadata(&mut node.metadata, generation, "orchestrator-metrics");
                }

                if !phase_nodes.is_empty() {
                    let phase_files: Vec<String> = phase_nodes
                        .iter()
                        .filter_map(|n| n.file.clone())
                        .collect::<HashSet<_>>()
                        .into_iter()
                        .collect();
                    rfdb.commit_batch(&phase_files, &phase_nodes, &phase_edges, true)
                        .await
                        .context("Failed to commit phase metrics")?;
                }
            }

            let total_ms = pipeline_start.elapsed().as_millis() as u64;
            println!(
                "Resolve complete: resolve {resolve_ms}ms, diagnostics {diagnostics_ms}ms, depends_on {depends_on_ms}ms, flush {compact_ms}ms, total {total_ms}ms"
            );

            Ok(())
        }

        Commands::CommitDirs {
            config: config_path,
            socket,
        } => {
            let cfg = config::load(&config_path)?.with_defaults();

            let socket_path = socket
                .or(cfg.rfdb_socket.clone())
                .unwrap_or_else(|| PathBuf::from("/tmp/rfdb.sock"));

            let mut rfdb = rfdb::RfdbClient::connect(&socket_path).await?;

            // Discover files using the same discovery code as analyze.
            let files = discovery::discover(&cfg)?;
            tracing::info!(file_count = files.len(), "Discovered files for commit-dirs");

            let root_str = cfg.root.to_string_lossy().to_string();
            let root_prefix = if root_str.ends_with('/') {
                root_str.clone()
            } else {
                format!("{root_str}/")
            };
            let relative_files: Vec<String> = files
                .iter()
                .map(|p| {
                    let abs = p.display().to_string();
                    abs.strip_prefix(&root_prefix).unwrap_or(&abs).to_string()
                })
                .collect();

            let (dir_nodes, dir_edges, mut cleanup_files) =
                directory_nodes::build(&relative_files);

            if dir_nodes.is_empty() {
                println!("No directory/file nodes to commit.");
                return Ok(());
            }

            // Also clean up legacy virtual path from earlier releases that
            // stored all DIRECTORY/FILE nodes under a single synthetic file.
            cleanup_files.push("__grafema_virtual/directory-structure".to_string());

            let start = std::time::Instant::now();
            rfdb.commit_batch(&cleanup_files, &dir_nodes, &dir_edges, false)
                .await
                .context("Failed to commit directory structure")?;

            println!(
                "Committed {} directory/file nodes, {} CONTAINS edges in {}ms",
                dir_nodes.len(),
                dir_edges.len(),
                start.elapsed().as_millis()
            );

            Ok(())
        }

        Commands::Layout {
            synthetic,
            socket,
            config,
            pack_only,
            seed,
            edge_density,
            dump_json,
            commit,
            verbose,
        } => {
            let t_total = std::time::Instant::now();
            // Hold the RFDB client past the load step when --commit is set,
            // so the commit phase can reuse the same connection. Synthetic
            // mode never needs an RFDB client.
            let mut rfdb_for_commit: Option<grafema_orchestrator::rfdb::RfdbClient> = None;
            // Pick input source. Clap's `conflicts_with` already rejects
            // (Some, Some) at parse time, so the unreachable arm is just a
            // belt-and-braces guard.
            let input = match (synthetic, socket.as_ref(), config.as_ref()) {
                (Some(n), None, _) => {
                    eprintln!(
                        "Generating synthetic tree: {} leaves, seed {}, edge density {}",
                        n, seed, edge_density
                    );
                    grafema_orchestrator::layout::generate(n, seed, edge_density)
                }
                (None, Some(sock), Some(_cfg)) => {
                    // `--config` is reserved for future use (auto-detect socket
                    // path, project-aware reporting). For now we just require
                    // the user to pass `--socket` explicitly.
                    eprintln!("Loading layout input from RFDB at {}", sock.display());
                    let mut rfdb = grafema_orchestrator::rfdb::RfdbClient::connect(sock)
                        .await
                        .with_context(|| {
                            format!("Failed to connect to RFDB at {}", sock.display())
                        })?;
                    let loaded = grafema_orchestrator::layout::load_from_rfdb(&mut rfdb).await?;
                    // Stash the live connection for the commit phase; if --commit
                    // isn't set this just gets dropped at the end of the arm.
                    rfdb_for_commit = Some(rfdb);
                    loaded
                }
                (None, None, _) => {
                    anyhow::bail!(
                        "layout: must provide either --synthetic N or --socket <path> --config <path>"
                    );
                }
                (Some(_), Some(_), _) => {
                    unreachable!("clap `conflicts_with` should prevent --synthetic + --socket")
                }
                (None, Some(_), None) => {
                    unreachable!("clap `requires = config` should prevent --socket without --config")
                }
            };
            eprintln!(
                "Tree: {} folders (max depth {}), {} edges, {} nodes",
                input.tree.len(),
                input.tree.max_depth(),
                input.edges.len(),
                input.n_nodes
            );

            let opts = grafema_orchestrator::layout::RunOpts { pack_only };
            let result = grafema_orchestrator::layout::run_layout(&input, &opts);

            let report = grafema_orchestrator::layout::validate(&result.coords, &input.tree);
            eprintln!();
            eprint!("{}", report);

            eprintln!();
            eprintln!("Stats:");
            eprintln!(
                "  pack:   {} ms, Σlinks = {:.1}",
                result.stats.pack_ms, result.stats.sigma_link_pre
            );
            if !pack_only {
                let pct = |after: f64, before: f64| -> f64 {
                    if before == 0.0 {
                        0.0
                    } else {
                        (after - before) / before * 100.0
                    }
                };
                eprintln!(
                    "  iswap:  {} ms, {} swaps, Σlinks = {:.1} ({:+.1}%)",
                    result.stats.iswap_ms,
                    result.stats.iswap_swaps,
                    result.stats.sigma_link_after_iswap,
                    pct(result.stats.sigma_link_after_iswap, result.stats.sigma_link_pre)
                );
                eprintln!(
                    "  xswap:  {} ms, {} swaps, Σlinks = {:.1} ({:+.1}%)",
                    result.stats.xswap_ms,
                    result.stats.xswap_swaps,
                    result.stats.sigma_link_after_xswap,
                    pct(result.stats.sigma_link_after_xswap, result.stats.sigma_link_pre)
                );
            }
            eprintln!("  total:  {} ms", t_total.elapsed().as_millis());

            if verbose {
                for t in &report.torn {
                    eprintln!("  torn: {} ({}/{} connected)", t.path, t.connected, t.size);
                }
            }

            if let Some(path) = dump_json {
                let pairs: Vec<(grafema_orchestrator::layout::NodeIdx, &str)> =
                    input.iter_leaf_paths().collect();
                let f = std::fs::File::create(&path)
                    .with_context(|| format!("Failed to create {}", path.display()))?;
                grafema_orchestrator::layout::dump_to_writer(
                    &pairs,
                    &result.coords,
                    &result.stats,
                    f,
                )
                .with_context(|| format!("Failed to write JSON to {}", path.display()))?;
                eprintln!("JSON dumped to {}", path.display());
            }

            // ── Commit phase (optional) ────────────────────────────────────
            // --commit only makes sense with --socket. Synthetic leaf paths
            // don't correspond to any MODULE in any RFDB, so committing
            // would produce edges that point at nothing. Print a warning
            // and skip rather than error — the user may have left --commit
            // on while iterating on synthetic dry-runs.
            if commit {
                if let Some(mut rfdb) = rfdb_for_commit {
                    eprintln!("Committing LAYOUT_POSITION edges to RFDB...");
                    let n = grafema_orchestrator::layout::commit_layout(
                        &mut rfdb, &input, &result,
                    )
                    .await?;
                    eprintln!("Committed {} LAYOUT_POSITION edges", n);
                } else {
                    eprintln!(
                        "warning: --commit requires --socket; ignoring (synthetic mode)"
                    );
                }
            }

            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_git_remote_ssh() {
        assert_eq!(
            parse_git_remote_authority("git@github.com:owner/repo.git"),
            Some("github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn test_parse_git_remote_https() {
        assert_eq!(
            parse_git_remote_authority("https://github.com/owner/repo.git"),
            Some("github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn test_parse_git_remote_https_no_git_suffix() {
        assert_eq!(
            parse_git_remote_authority("https://github.com/owner/repo"),
            Some("github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn test_parse_git_remote_invalid() {
        assert_eq!(parse_git_remote_authority("not-a-url"), None);
    }
}
