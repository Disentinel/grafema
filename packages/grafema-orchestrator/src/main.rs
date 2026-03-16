use grafema_orchestrator::{analyzer, config, discovery, gc, plugin, process_pool, profiler, rfdb, source_hash};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::collections::HashSet;
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
    },
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Number of CPU cores available for resolve workers.
/// Reserves 1 core for the main thread / RFDB / OS.
fn resolve_worker_count() -> usize {
    let cpus = num_cpus();
    let available = if cpus > 1 { cpus - 1 } else { 1 };
    // Cap at 7 (number of JS resolution steps — more workers than steps wastes memory)
    std::cmp::min(7, std::cmp::max(1, available))
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

            // 1. Discover files
            let files = discovery::discover(&cfg)?;
            tracing::info!(count = files.len(), "Discovered files");
            profile!("files_discovered", "count" => files.len());

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
            let mut gen_tracker = gc::GenerationTracker::new(0);
            let generation = gen_tracker.bump();
            let (changed_files, unchanged_files) =
                gc::filter_changed_files(&files, &gen_tracker, force)?;

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
            let (js_files, hs_files, rs_files, java_files, kotlin_files, py_files, go_files, cpp_files, swift_files, objc_files, beam_files) = config::partition_by_language(&changed_files);
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
            const INGEST_BATCH_SIZE: usize = 20;
            let mut total_nodes = 0usize;
            let mut total_edges = 0usize;
            let mut total_errors = 0usize;
            let mut total_files_committed = 0usize;
            let root_str = cfg.root.display().to_string();
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

                // Relativize + URI format
                for result in &mut results {
                    if let Some(ref mut analysis) = result.analysis {
                        analysis.relativize_paths(root_str);
                        analysis.ensure_function_contains_edges();
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
                        tokio::spawn(async move {
                            let results = $analyze_fn(&files_vec, jobs, &analyzers).await;
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
                tokio::spawn(async move {
                    analyzer::analyze_js_files_streaming(
                        js_files, js_jobs, js_analyzer_path, tx_js,
                    )
                    .await;
                });
            }

            // 4b–4k. All other languages — pool-based analysis, results forwarded
            spawn_analysis!(hs_files, "Haskell", analyzer::analyze_haskell_files_parallel_pooled);
            spawn_analysis!(rs_files, "Rust", analyzer::analyze_rust_files_parallel_pooled);
            spawn_analysis!(java_files, "Java", analyzer::analyze_java_files_parallel_pooled);
            spawn_analysis!(kotlin_files, "Kotlin", analyzer::analyze_kotlin_files_parallel_pooled);
            spawn_analysis!(py_files, "Python", analyzer::analyze_python_files_parallel_pooled);
            spawn_analysis!(go_files, "Go", analyzer::analyze_go_files_parallel_pooled);
            spawn_analysis!(swift_files, "Swift", analyzer::analyze_swift_files_parallel_pooled);
            spawn_analysis!(objc_files, "Obj-C", analyzer::analyze_objc_files_parallel_pooled);
            spawn_analysis!(beam_files, "BEAM", analyzer::analyze_beam_files_parallel_pooled);

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
                tokio::spawn(async move {
                    let results = analyzer::analyze_cpp_files_parallel_pooled(
                        &cpp_files_vec,
                        cpp_jobs,
                        &cpp_analyzers,
                        compile_commands.as_ref(),
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
            while let Some(result) = rx.recv().await {
                batch.push(result);
                if batch.len() >= INGEST_BATCH_SIZE {
                    let full_batch = std::mem::replace(
                        &mut batch,
                        Vec::with_capacity(INGEST_BATCH_SIZE),
                    );
                    let batch_len = full_batch.len();
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
                    total_nodes += n;
                    total_edges += e;
                    total_errors += err;
                    total_files_committed += batch_len;
                }
            }
            // Flush remaining results
            if !batch.is_empty() {
                let batch_len = batch.len();
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
                total_nodes += n;
                total_edges += e;
                total_errors += err;
                total_files_committed += batch_len;
            }

            // NOTE: Do NOT flush/rebuild_indexes here. Analysis commits
            // tombstone resolution edges (via delete_node cascading to edges).
            // If we flush now, tombstones get persisted to the store before
            // resolution can clear them via add_edges. Resolution edges would
            // then be removed by compaction. Let compact() handle the flush.
            // V2 engine write buffers are queryable without flushing.

            tracing::info!(
                nodes = total_nodes,
                edges = total_edges,
                errors = total_errors,
                "Analysis complete"
            );
            profile!("analysis_complete",
                "nodes" => total_nodes, "edges" => total_edges, "errors" => total_errors);

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

            // Collect IMPORTS_FROM edges from all import resolvers for DEPENDS_ON derivation
            let mut all_imports_from_edges: Vec<(String, String)> = Vec::new();

            // Build file → MODULE semantic ID map from RFDB (full graph)
            let file_to_module: std::collections::HashMap<String, String> = {
                let module_nodes = rfdb.query_nodes_by_type("MODULE").await
                    .unwrap_or_default();
                module_nodes
                    .into_iter()
                    .filter_map(|n| {
                        let file = n.file?;
                        let sid = n.semantic_id.or(Some(n.id))?;
                        Some((file, sid))
                    })
                    .collect()
            };

            // Helper: validate, stamp, tag, commit a resolution output
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
                    .collect::<std::collections::HashSet<_>>()
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

            // 8. Run JS resolution with streaming double-buffer
            if js_file_count > 0 {
                let pool_size = resolve_worker_count();
                tracing::info!(
                    workers = pool_size,
                    "Running JS streaming resolution"
                );
                profile!("js_resolve_start", "workers" => pool_size);

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    max_message_size: 200 * 1024 * 1024, // 200MB for large shards
                    request_timeout: std::time::Duration::from_secs(300),
                };

                match process_pool::ProcessPool::new(resolve_pool_config, pool_size) {
                    Ok(resolve_pool) => {
                        let handles = resolve_pool.acquire_all().await?;

                        let total_streamed = plugin::stream_resolve_nodes_to_workers(
                            &mut rfdb,
                            config::Language::JavaScript,
                            &handles,
                            &ws_packages,
                        ).await?;
                        profile!("js_stream_complete", "nodes" => total_streamed);

                        if total_streamed > 0 {
                            let empty_ws: &[plugin::WorkspacePackageWire] = &[];
                            // (daemon_cmd, commit_name, workspace_packages)
                            let js_commands: Vec<(&str, &str, &[plugin::WorkspacePackageWire])> = vec![
                                ("same-file-calls", "same-file-calls", empty_ws),
                                ("js-local-refs", "js-local-refs", empty_ws),
                                ("runtime-globals", "runtime-globals", empty_ws),
                                ("builtins", "builtins", empty_ws),
                                ("imports", "js-import-resolution", &ws_packages),
                                ("cross-file-calls", "cross-file-calls", empty_ws),
                                ("property-access", "property-access", empty_ws),
                            ];

                            for (cmd, commit_name, ws) in js_commands {
                                profile!("js_resolve_cmd_start", "cmd" => cmd);
                                let mut output = plugin::run_resolve_on_workers(cmd, &handles, ws)
                                    .await
                                    .with_context(|| format!("{commit_name} resolution failed"))?;

                                if cmd == "imports" {
                                    for edge in &output.edges {
                                        if edge.edge_type == "IMPORTS_FROM" {
                                            all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                        }
                                    }
                                }

                                commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                                profile!("js_resolve_cmd_complete", "cmd" => cmd,
                                    "nodes" => output.nodes.len(), "edges" => output.edges.len());
                            }
                        }

                        plugin::clear_context_on_workers(&handles).await
                            .context("Failed to clear context from resolve workers")?;
                        drop(handles);
                        resolve_pool.shutdown().await;
                        profile!("js_resolve_complete");
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
                profile!("haskell_resolve_start");
                let hs_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.haskell_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(hs_pool_config, 1) {
                    Ok(hs_pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Haskell],
                            &[("haskell-imports", &[]), ("haskell-local-refs", &[])],
                            &hs_pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let commit_name = match cmd.as_str() {
                                "haskell-imports" => "haskell-import-resolution",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                        }
                        hs_pool.shutdown().await;
                        profile!("haskell_resolve_complete");
                    }
                    Err(e) => {
                        tracing::warn!("Failed to create Haskell resolve pool: {e}");
                    }
                }
            }

            // 8b. Run Rust resolution (streaming)
            if !rs_files.is_empty() {
                profile!("rust_resolve_start");
                let rs_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.rust_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(rs_pool_config, 1) {
                    Ok(rs_pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Rust],
                            &[("rust-imports", &[])],
                            &rs_pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let commit_name = match cmd.as_str() {
                                "rust-imports" => "rust-import-resolution",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                        }
                        rs_pool.shutdown().await;
                        profile!("rust_resolve_complete");
                    }
                    Err(e) => {
                        tracing::warn!("Failed to create Rust resolve pool: {e}");
                    }
                }
            }

            // 8c. Run Java resolution (streaming)
            if !java_files.is_empty() {
                profile!("java_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.java_resolve_path(),
                    args: vec!["--daemon".to_string()],
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
                        profile!("java_resolve_complete");
                    }
                    Err(e) => tracing::warn!("Failed to create Java resolve pool: {e}"),
                }
            }

            // 8d. Run Kotlin resolution (streaming)
            if !kotlin_files.is_empty() {
                profile!("kotlin_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.kotlin_resolve_path(),
                    args: vec!["--daemon".to_string()],
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
                        profile!("kotlin_resolve_complete");
                    }
                    Err(e) => tracing::warn!("Failed to create Kotlin resolve pool: {e}"),
                }
            }

            // 8e. Run Python resolution (streaming)
            if !py_files.is_empty() {
                profile!("python_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.python_resolve_path(),
                    args: vec!["--daemon".to_string()],
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
                        profile!("python_resolve_complete");
                    }
                    Err(e) => tracing::warn!("Failed to create Python resolve pool: {e}"),
                }
            }

            // 8f. Run Go resolution (streaming)
            if !go_files.is_empty() {
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
                        profile!("go_resolve_complete");
                    }
                    Err(e) => tracing::warn!("Failed to create Go resolve pool: {e}"),
                }
            }

            // 8g. Run Swift resolution (streaming)
            if !swift_files.is_empty() {
                profile!("swift_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.swift_resolve_path(),
                    args: vec!["--daemon".to_string()],
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
                        profile!("swift_resolve_complete");
                    }
                    Err(e) => tracing::warn!("Failed to create Swift resolve pool: {e}"),
                }
            }

            // 8h. Run Apple cross-language resolution (streaming, Swift + Obj-C)
            if !swift_files.is_empty() && !objc_files.is_empty() {
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.apple_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
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
                    }
                    Err(e) => tracing::warn!("Failed to create Apple cross-resolve pool: {e}"),
                }
            }

            // 8i. Run JVM cross-language resolution (streaming, Java + Kotlin)
            if !java_files.is_empty() && !kotlin_files.is_empty() {
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.jvm_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
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
                    }
                    Err(e) => tracing::warn!("Failed to create JVM cross-resolve pool: {e}"),
                }
            }

            // 8j. Run C/C++ resolution (streaming)
            if !cpp_files.is_empty() {
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.cpp_resolve_path(),
                    args: vec!["--daemon".to_string()],
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
                    }
                    Err(e) => tracing::warn!("Failed to create C/C++ resolve pool: {e}"),
                }
            }

            // 8k. Run BEAM resolution (streaming)
            if !beam_files.is_empty() {
                profile!("beam_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.beam_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Beam],
                            &[("beam-imports", &[]), ("beam-local-refs", &[])],
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
                        profile!("beam_resolve_complete");
                    }
                    Err(e) => tracing::warn!("Failed to create BEAM resolve pool: {e}"),
                }
            }

            // 8l. Run user-defined plugins via DAG (if any non-default plugins configured)
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

            // 9. Derive MODULE→MODULE DEPENDS_ON edges from IMPORTS_FROM
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

            // Compact to deduplicate segments after all commits.
            // This is needed because:
            // 1. Re-analyzed files create new segment versions alongside old ones.
            //    The superseded_node/edge_count in the engine corrects node_count()
            //    for edges that go through the delete+readd path.
            // 2. DEPENDS_ON and other derived edges are committed with empty
            //    changed_files (no deletion phase), so old segment versions
            //    accumulate. Compaction deduplicates these by (src,dst,type) key.
            profile!("compact_start");
            rfdb.compact().await.context("Failed to compact")?;
            profile!("compact_complete");

            // 10. Summary
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
