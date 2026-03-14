use grafema_orchestrator::{analyzer, config, discovery, gc, plugin, process_pool, rfdb, source_hash};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::collections::HashSet;
use std::path::PathBuf;

/// Query ALL resolve-type nodes from RFDB for a given language.
///
/// Unlike `collect_resolve_nodes_for_lang` which only sees nodes from changed
/// files (via `results`), this queries the full graph — ensuring cross-file
/// resolution works correctly in incremental mode.
async fn query_resolve_nodes_for_lang(
    rfdb_client: &mut rfdb::RfdbClient,
    lang: config::Language,
) -> Result<Vec<serde_json::Value>> {
    let mut all_nodes = Vec::new();

    for node_type in analyzer::resolve_node_types() {
        let nodes = rfdb_client.query_nodes_by_type(node_type).await?;
        for node in &nodes {
            if let Some(ref file) = node.file {
                if config::detect_language(std::path::Path::new(file)) == Some(lang) {
                    all_nodes.push(analyzer::wire_node_to_resolve_json(node));
                }
            }
        }
    }

    Ok(all_nodes)
}

/// Query ALL resolve-type nodes from RFDB for JVM languages (Java + Kotlin).
async fn query_resolve_nodes_for_jvm(
    rfdb_client: &mut rfdb::RfdbClient,
) -> Result<Vec<serde_json::Value>> {
    let mut all_nodes = Vec::new();

    for node_type in analyzer::resolve_node_types() {
        let nodes = rfdb_client.query_nodes_by_type(node_type).await?;
        for node in &nodes {
            if let Some(ref file) = node.file {
                let lang = config::detect_language(std::path::Path::new(file));
                if matches!(lang, Some(config::Language::Java) | Some(config::Language::Kotlin)) {
                    all_nodes.push(analyzer::wire_node_to_resolve_json(node));
                }
            }
        }
    }

    Ok(all_nodes)
}

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

            // 1. Discover files
            let files = discovery::discover(&cfg)?;
            tracing::info!(count = files.len(), "Discovered files");

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

            // 4. Analyze files by language
            let mut results = Vec::new();

            // 4a. Analyze JS/TS files (OXC parse → grafema-analyzer daemon pool)
            if !js_files.is_empty() {
                tracing::info!(count = js_files.len(), "Analyzing JS/TS files");
                let js_results = analyzer::analyze_files_parallel_pooled(&js_files, jobs, &cfg.analyzers).await;
                results.extend(js_results);
            }

            // 4b. Analyze Haskell files (haskell-analyzer daemon pool, no OXC)
            if !hs_files.is_empty() {
                tracing::info!(count = hs_files.len(), "Analyzing Haskell files");
                let hs_results = analyzer::analyze_haskell_files_parallel_pooled(&hs_files, jobs, &cfg.analyzers).await;
                results.extend(hs_results);
            }

            // 4c. Analyze Rust files (syn parse in orchestrator → grafema-rust-analyzer daemon pool)
            if !rs_files.is_empty() {
                tracing::info!(count = rs_files.len(), "Analyzing Rust files");
                let rs_results = analyzer::analyze_rust_files_parallel_pooled(&rs_files, jobs, &cfg.analyzers).await;
                results.extend(rs_results);
            }

            // 4d. Analyze Java files (java-parser → java-analyzer daemon pools)
            if !java_files.is_empty() {
                tracing::info!(count = java_files.len(), "Analyzing Java files");
                let java_results = analyzer::analyze_java_files_parallel_pooled(&java_files, jobs, &cfg.analyzers).await;
                results.extend(java_results);
            }

            // 4e. Analyze Kotlin files (kotlin-parser → kotlin-analyzer daemon pools)
            if !kotlin_files.is_empty() {
                tracing::info!(count = kotlin_files.len(), "Analyzing Kotlin files");
                let kotlin_results = analyzer::analyze_kotlin_files_parallel_pooled(&kotlin_files, jobs, &cfg.analyzers).await;
                results.extend(kotlin_results);
            }

            // 4f. Analyze Python files (rustpython-parser → python-analyzer daemon pool)
            if !py_files.is_empty() {
                tracing::info!(count = py_files.len(), "Analyzing Python files");
                let py_results = analyzer::analyze_python_files_parallel_pooled(&py_files, jobs, &cfg.analyzers).await;
                results.extend(py_results);
            }

            // 4g. Analyze Go files (go-parser → go-analyzer daemon pools)
            if !go_files.is_empty() {
                tracing::info!(count = go_files.len(), "Analyzing Go files");
                let go_results = analyzer::analyze_go_files_parallel_pooled(&go_files, jobs, &cfg.analyzers).await;
                results.extend(go_results);
            }

            // 4h. Analyze C/C++ files (libclang parse → cpp-analyzer daemon pool)
            if !cpp_files.is_empty() {
                tracing::info!(count = cpp_files.len(), "Analyzing C/C++ files");

                // Search for compile_commands.json in project root and build directories
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

                let cpp_results = analyzer::analyze_cpp_files_parallel_pooled(
                    &cpp_files,
                    jobs,
                    &cfg.analyzers,
                    compile_commands.as_ref(),
                ).await;
                results.extend(cpp_results);
            }

            // 4i. Analyze Swift files (swift-parser → swift-analyzer daemon pools)
            if !swift_files.is_empty() {
                tracing::info!(count = swift_files.len(), "Analyzing Swift files");
                let swift_results = analyzer::analyze_swift_files_parallel_pooled(&swift_files, jobs, &cfg.analyzers).await;
                results.extend(swift_results);
            }

            // 4j. Analyze Obj-C files (objc-parser → objc-analyzer daemon pools)
            if !objc_files.is_empty() {
                tracing::info!(count = objc_files.len(), "Analyzing Obj-C files");
                let objc_results = analyzer::analyze_objc_files_parallel_pooled(&objc_files, jobs, &cfg.analyzers).await;
                results.extend(objc_results);
            }

            // 4k. Analyze BEAM (Elixir/Erlang) files (beam-analyzer daemon pool, no OXC)
            if !beam_files.is_empty() {
                tracing::info!(count = beam_files.len(), "Analyzing BEAM files");
                let beam_results = analyzer::analyze_beam_files_parallel_pooled(&beam_files, jobs, &cfg.analyzers).await;
                results.extend(beam_results);
            }

            // 5. Relativize paths: convert absolute → relative (to project root)
            //    VS Code and CLI query with relative paths, so RFDB must store relative paths.
            let root_str = cfg.root.display().to_string();
            for result in &mut results {
                if let Some(ref mut analysis) = result.analysis {
                    analysis.relativize_paths(&root_str);
                    analysis.ensure_function_contains_edges();
                }
            }

            // 5b. Convert semantic IDs to URI format
            let authority = resolve_authority(&cfg);
            for result in &mut results {
                if let Some(ref mut analysis) = result.analysis {
                    analysis.to_uri_format(&authority);
                }
            }

            // 6. Ingest results into RFDB (deferred indexing for performance)
            //    Batch all results into a single commit to avoid N round-trips.
            let mut total_nodes = 0usize;
            let mut total_edges = 0usize;
            let mut total_errors = 0usize;
            let mut all_wire_nodes: Vec<rfdb::WireNode> = Vec::new();
            let mut all_wire_edges: Vec<rfdb::WireEdge> = Vec::new();
            let mut all_changed_files: Vec<String> = Vec::new();

            for result in &results {
                if !result.errors.is_empty() {
                    total_errors += result.errors.len();
                    for err in &result.errors {
                        tracing::error!(file = %result.file.display(), "{err}");
                    }
                }

                if let Some(ref analysis) = result.analysis {
                    let mut wire_nodes = analyzer::to_wire_nodes(analysis);
                    let mut wire_edges = analyzer::to_wire_edges(analysis);

                    // Stamp generation metadata on all nodes/edges
                    for node in &mut wire_nodes {
                        gc::stamp_node_metadata(&mut node.metadata, generation, "analyzer");
                    }
                    for edge in &mut wire_edges {
                        gc::stamp_edge_metadata(&mut edge.metadata, generation, "analyzer");
                    }

                    total_nodes += wire_nodes.len();
                    total_edges += wire_edges.len();

                    all_changed_files.push(analysis.file.clone());
                    all_wire_nodes.extend(wire_nodes);
                    all_wire_edges.extend(wire_edges);
                }
            }

            // Single batched commit (internally chunked by commit_batch if >10k)
            if !all_wire_nodes.is_empty() || !all_wire_edges.is_empty() {
                tracing::info!(
                    files = all_changed_files.len(),
                    nodes = all_wire_nodes.len(),
                    edges = all_wire_edges.len(),
                    "Committing analysis batch to RFDB"
                );
                rfdb.commit_batch(&all_changed_files, &all_wire_nodes, &all_wire_edges, true)
                    .await
                    .context("Failed to commit analysis batch")?;
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

            // 8. Run resolution plugins with FULL graph from RFDB
            //    (queries all nodes, not just changed files — fixes incremental resolution)
            let resolve_nodes = if !js_files.is_empty() {
                query_resolve_nodes_for_lang(&mut rfdb, config::Language::JavaScript).await?
            } else {
                Vec::new()
            };
            if !resolve_nodes.is_empty() {
                tracing::info!(
                    nodes = resolve_nodes.len(),
                    "Running built-in resolution with full graph nodes"
                );

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    ..process_pool::PoolConfig::default()
                };

                match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(resolve_pool) => {
                        // Step 1: Import resolution (with workspace packages for cross-package imports)
                        let mut import_output = plugin::run_resolve_with_nodes(
                            "imports",
                            &resolve_nodes,
                            &ws_packages,
                            &resolve_pool,
                        )
                        .await
                        .context("Import resolution failed")?;
                        plugin::validate_plugin_output(&import_output)?;
                        plugin::stamp_metadata(&mut import_output, "js-import-resolution", generation);
                        tag_virtual_nodes(&mut import_output, "js-import-resolution");

                        let import_files: Vec<String> = import_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&import_files, &import_output.nodes, &import_output.edges, true)
                            .await
                            .context("Failed to commit import resolution output")?;

                        // Collect IMPORTS_FROM edges for DEPENDS_ON derivation
                        for edge in &import_output.edges {
                            if edge.edge_type == "IMPORTS_FROM" {
                                all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                            }
                        }

                        tracing::info!(
                            nodes = import_output.nodes.len(),
                            edges = import_output.edges.len(),
                            "Import resolution complete"
                        );

                        // Step 2: Runtime globals (uses updated graph)
                        let mut globals_output = plugin::run_resolve_with_nodes(
                            "runtime-globals",
                            &resolve_nodes,
                            &[],
                            &resolve_pool,
                        )
                        .await
                        .context("Runtime globals resolution failed")?;
                        plugin::validate_plugin_output(&globals_output)?;
                        plugin::stamp_metadata(&mut globals_output, "runtime-globals", generation);
                        tag_virtual_nodes(&mut globals_output, "runtime-globals");

                        let globals_files: Vec<String> = globals_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&globals_files, &globals_output.nodes, &globals_output.edges, true)
                            .await
                            .context("Failed to commit runtime globals output")?;

                        tracing::info!(
                            nodes = globals_output.nodes.len(),
                            edges = globals_output.edges.len(),
                            "Runtime globals resolution complete"
                        );

                        // Step 3: Builtins resolution (Node.js builtin modules)
                        let mut builtins_output = plugin::run_resolve_with_nodes(
                            "builtins",
                            &resolve_nodes,
                            &[],
                            &resolve_pool,
                        )
                        .await
                        .context("Builtins resolution failed")?;
                        plugin::validate_plugin_output(&builtins_output)?;
                        plugin::stamp_metadata(&mut builtins_output, "builtins", generation);
                        tag_virtual_nodes(&mut builtins_output, "builtins");

                        let builtins_files: Vec<String> = builtins_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&builtins_files, &builtins_output.nodes, &builtins_output.edges, true)
                            .await
                            .context("Failed to commit builtins resolution output")?;

                        tracing::info!(
                            nodes = builtins_output.nodes.len(),
                            edges = builtins_output.edges.len(),
                            "Builtins resolution complete"
                        );

                        // Step 4: Cross-file CALLS resolution
                        let mut cross_file_output = plugin::run_resolve_with_nodes(
                            "cross-file-calls",
                            &resolve_nodes,
                            &[],
                            &resolve_pool,
                        )
                        .await
                        .context("Cross-file CALLS resolution failed")?;
                        plugin::validate_plugin_output(&cross_file_output)?;
                        plugin::stamp_metadata(&mut cross_file_output, "cross-file-calls", generation);
                        tag_virtual_nodes(&mut cross_file_output, "cross-file-calls");

                        let cross_file_files: Vec<String> = cross_file_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&cross_file_files, &cross_file_output.nodes, &cross_file_output.edges, true)
                            .await
                            .context("Failed to commit cross-file CALLS output")?;

                        tracing::info!(
                            nodes = cross_file_output.nodes.len(),
                            edges = cross_file_output.edges.len(),
                            "Cross-file CALLS resolution complete"
                        );

                        // Step 5: Same-file CALLS resolution
                        let mut same_file_output = plugin::run_resolve_with_nodes(
                            "same-file-calls",
                            &resolve_nodes,
                            &[],
                            &resolve_pool,
                        )
                        .await
                        .context("Same-file CALLS resolution failed")?;
                        plugin::validate_plugin_output(&same_file_output)?;
                        plugin::stamp_metadata(&mut same_file_output, "same-file-calls", generation);
                        tag_virtual_nodes(&mut same_file_output, "same-file-calls");

                        let same_file_files: Vec<String> = same_file_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&same_file_files, &same_file_output.nodes, &same_file_output.edges, true)
                            .await
                            .context("Failed to commit same-file CALLS output")?;

                        tracing::info!(
                            nodes = same_file_output.nodes.len(),
                            edges = same_file_output.edges.len(),
                            "Same-file CALLS resolution complete"
                        );

                        // Step 6: Property access resolution
                        let mut prop_access_output = plugin::run_resolve_with_nodes(
                            "property-access",
                            &resolve_nodes,
                            &[],
                            &resolve_pool,
                        )
                        .await
                        .context("Property access resolution failed")?;
                        plugin::validate_plugin_output(&prop_access_output)?;
                        plugin::stamp_metadata(&mut prop_access_output, "property-access", generation);
                        tag_virtual_nodes(&mut prop_access_output, "property-access");

                        let prop_access_files: Vec<String> = prop_access_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&prop_access_files, &prop_access_output.nodes, &prop_access_output.edges, true)
                            .await
                            .context("Failed to commit property access output")?;

                        tracing::info!(
                            nodes = prop_access_output.nodes.len(),
                            edges = prop_access_output.edges.len(),
                            "Property access resolution complete"
                        );

                        // Step 7: JS/TS local refs resolution
                        let mut js_local_refs_output = plugin::run_resolve_with_nodes(
                            "js-local-refs",
                            &resolve_nodes,
                            &[],
                            &resolve_pool,
                        )
                        .await
                        .context("JS local refs resolution failed")?;
                        plugin::validate_plugin_output(&js_local_refs_output)?;
                        plugin::stamp_metadata(&mut js_local_refs_output, "js-local-refs", generation);
                        tag_virtual_nodes(&mut js_local_refs_output, "js-local-refs");

                        let js_local_refs_files: Vec<String> = js_local_refs_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&js_local_refs_files, &js_local_refs_output.nodes, &js_local_refs_output.edges, true)
                            .await
                            .context("Failed to commit JS local refs output")?;

                        tracing::info!(
                            nodes = js_local_refs_output.nodes.len(),
                            edges = js_local_refs_output.edges.len(),
                            "JS local refs resolution complete"
                        );

                        resolve_pool.shutdown().await;
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to create resolve pool, skipping built-in resolution: {e}"
                        );
                    }
                }
            }

            // 8a. Run Haskell import resolution (if Haskell files were analyzed)
            if !hs_files.is_empty() {
                let hs_resolve_nodes = query_resolve_nodes_for_lang(&mut rfdb, config::Language::Haskell).await?;
                if !hs_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = hs_resolve_nodes.len(),
                        "Running Haskell import resolution"
                    );

                    let hs_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.haskell_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(hs_resolve_pool_config, 1) {
                        Ok(hs_resolve_pool) => {
                            let mut hs_import_output = plugin::run_resolve_with_nodes(
                                "haskell-imports",
                                &hs_resolve_nodes,
                                &[],
                                &hs_resolve_pool,
                            )
                            .await
                            .context("Haskell import resolution failed")?;
                            plugin::validate_plugin_output(&hs_import_output)?;
                            plugin::stamp_metadata(&mut hs_import_output, "haskell-import-resolution", generation);
                            tag_virtual_nodes(&mut hs_import_output, "haskell-import-resolution");

                            let hs_import_files: Vec<String> = hs_import_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&hs_import_files, &hs_import_output.nodes, &hs_import_output.edges, true)
                                .await
                                .context("Failed to commit Haskell import resolution output")?;

                            for edge in &hs_import_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = hs_import_output.nodes.len(),
                                edges = hs_import_output.edges.len(),
                                "Haskell import resolution complete"
                            );

                            // Step 8b: Haskell local refs resolution
                            let mut hs_local_output = plugin::run_resolve_with_nodes(
                                "haskell-local-refs",
                                &hs_resolve_nodes,
                                &[],
                                &hs_resolve_pool,
                            )
                            .await
                            .context("Haskell local refs resolution failed")?;
                            plugin::validate_plugin_output(&hs_local_output)?;
                            plugin::stamp_metadata(&mut hs_local_output, "haskell-local-refs", generation);
                            tag_virtual_nodes(&mut hs_local_output, "haskell-local-refs");

                            let hs_local_files: Vec<String> = hs_local_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&hs_local_files, &hs_local_output.nodes, &hs_local_output.edges, true)
                                .await
                                .context("Failed to commit Haskell local refs output")?;

                            tracing::info!(
                                nodes = hs_local_output.nodes.len(),
                                edges = hs_local_output.edges.len(),
                                "Haskell local refs resolution complete"
                            );

                            hs_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create Haskell resolve pool, skipping Haskell import resolution: {e}"
                            );
                        }
                    }
                }
            }

            // 8b. Run Rust import resolution (if Rust files were analyzed)
            if !rs_files.is_empty() {
                let rs_resolve_nodes = query_resolve_nodes_for_lang(&mut rfdb, config::Language::Rust).await?;
                if !rs_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = rs_resolve_nodes.len(),
                        "Running Rust import resolution"
                    );

                    let rs_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.rust_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(rs_resolve_pool_config, 1) {
                        Ok(rs_resolve_pool) => {
                            let mut rs_import_output = plugin::run_resolve_with_nodes(
                                "rust-imports",
                                &rs_resolve_nodes,
                                &[],
                                &rs_resolve_pool,
                            )
                            .await
                            .context("Rust import resolution failed")?;
                            plugin::validate_plugin_output(&rs_import_output)?;
                            plugin::stamp_metadata(&mut rs_import_output, "rust-import-resolution", generation);
                            tag_virtual_nodes(&mut rs_import_output, "rust-import-resolution");

                            let rs_import_files: Vec<String> = rs_import_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&rs_import_files, &rs_import_output.nodes, &rs_import_output.edges, true)
                                .await
                                .context("Failed to commit Rust import resolution output")?;

                            for edge in &rs_import_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = rs_import_output.nodes.len(),
                                edges = rs_import_output.edges.len(),
                                "Rust import resolution complete"
                            );

                            rs_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create Rust resolve pool, skipping Rust import resolution: {e}"
                            );
                        }
                    }
                }
            }

            // 8c. Run Java resolution (imports, types, calls, annotations — single pass)
            if !java_files.is_empty() {
                let java_resolve_nodes = query_resolve_nodes_for_lang(&mut rfdb, config::Language::Java).await?;
                if !java_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = java_resolve_nodes.len(),
                        "Running Java resolution"
                    );

                    let java_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.java_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(java_resolve_pool_config, 1) {
                        Ok(java_resolve_pool) => {
                            let mut java_resolve_output = plugin::run_resolve_with_nodes(
                                "java-all",
                                &java_resolve_nodes,
                                &[],
                                &java_resolve_pool,
                            )
                            .await
                            .context("Java resolution failed")?;
                            plugin::validate_plugin_output(&java_resolve_output)?;
                            plugin::stamp_metadata(&mut java_resolve_output, "java-resolution", generation);
                            tag_virtual_nodes(&mut java_resolve_output, "java-resolution");

                            let java_resolve_files: Vec<String> = java_resolve_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&java_resolve_files, &java_resolve_output.nodes, &java_resolve_output.edges, true)
                                .await
                                .context("Failed to commit Java resolution output")?;

                            for edge in &java_resolve_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = java_resolve_output.nodes.len(),
                                edges = java_resolve_output.edges.len(),
                                "Java resolution complete"
                            );

                            java_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create Java resolve pool, skipping Java resolution: {e}"
                            );
                        }
                    }
                }
            }

            // 8d. Run Kotlin resolution (imports, types, calls, annotations — single pass)
            if !kotlin_files.is_empty() {
                let kotlin_resolve_nodes = query_resolve_nodes_for_lang(&mut rfdb, config::Language::Kotlin).await?;
                if !kotlin_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = kotlin_resolve_nodes.len(),
                        "Running Kotlin resolution"
                    );

                    let kotlin_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.kotlin_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(kotlin_resolve_pool_config, 1) {
                        Ok(kotlin_resolve_pool) => {
                            let mut kotlin_resolve_output = plugin::run_resolve_with_nodes(
                                "kotlin-all",
                                &kotlin_resolve_nodes,
                                &[],
                                &kotlin_resolve_pool,
                            )
                            .await
                            .context("Kotlin resolution failed")?;
                            plugin::validate_plugin_output(&kotlin_resolve_output)?;
                            plugin::stamp_metadata(&mut kotlin_resolve_output, "kotlin-resolution", generation);
                            tag_virtual_nodes(&mut kotlin_resolve_output, "kotlin-resolution");

                            let kotlin_resolve_files: Vec<String> = kotlin_resolve_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&kotlin_resolve_files, &kotlin_resolve_output.nodes, &kotlin_resolve_output.edges, true)
                                .await
                                .context("Failed to commit Kotlin resolution output")?;

                            for edge in &kotlin_resolve_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = kotlin_resolve_output.nodes.len(),
                                edges = kotlin_resolve_output.edges.len(),
                                "Kotlin resolution complete"
                            );

                            kotlin_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create Kotlin resolve pool, skipping Kotlin resolution: {e}"
                            );
                        }
                    }
                }
            }

            // 8e. Run Python resolution (imports, types, calls — single pass)
            if !py_files.is_empty() {
                let py_resolve_nodes = query_resolve_nodes_for_lang(&mut rfdb, config::Language::Python).await?;
                if !py_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = py_resolve_nodes.len(),
                        "Running Python resolution"
                    );

                    let py_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.python_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(py_resolve_pool_config, 1) {
                        Ok(py_resolve_pool) => {
                            let mut py_resolve_output = plugin::run_resolve_with_nodes(
                                "python-all",
                                &py_resolve_nodes,
                                &[],
                                &py_resolve_pool,
                            )
                            .await
                            .context("Python resolution failed")?;
                            plugin::validate_plugin_output(&py_resolve_output)?;
                            plugin::stamp_metadata(&mut py_resolve_output, "python-resolution", generation);
                            tag_virtual_nodes(&mut py_resolve_output, "python-resolution");

                            let py_resolve_files: Vec<String> = py_resolve_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&py_resolve_files, &py_resolve_output.nodes, &py_resolve_output.edges, true)
                                .await
                                .context("Failed to commit Python resolution output")?;

                            for edge in &py_resolve_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = py_resolve_output.nodes.len(),
                                edges = py_resolve_output.edges.len(),
                                "Python resolution complete"
                            );

                            py_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create Python resolve pool, skipping Python resolution: {e}"
                            );
                        }
                    }
                }
            }

            // 8f. Run Go resolution
            if !go_files.is_empty() {
                let go_resolve_nodes = query_resolve_nodes_for_lang(&mut rfdb, config::Language::Go).await?;
                if !go_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = go_resolve_nodes.len(),
                        "Running Go resolution"
                    );

                    let go_module_path = config::discover_go_module_path(&cfg.root);
                    let go_ws_packages: Vec<plugin::WorkspacePackageWire> = go_module_path
                        .map(|mp| vec![plugin::WorkspacePackageWire {
                            name: mp.clone(),
                            entry_point: String::new(),
                            package_dir: cfg.root.display().to_string(),
                        }])
                        .unwrap_or_default();

                    let go_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.go_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(go_resolve_pool_config, 1) {
                        Ok(go_resolve_pool) => {
                            let mut go_resolve_output = plugin::run_resolve_with_nodes(
                                "go-all",
                                &go_resolve_nodes,
                                &go_ws_packages,
                                &go_resolve_pool,
                            )
                            .await
                            .context("Go resolution failed")?;
                            plugin::validate_plugin_output(&go_resolve_output)?;
                            plugin::stamp_metadata(&mut go_resolve_output, "go-resolution", generation);
                            tag_virtual_nodes(&mut go_resolve_output, "go-resolution");

                            let go_resolve_files: Vec<String> = go_resolve_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&go_resolve_files, &go_resolve_output.nodes, &go_resolve_output.edges, true)
                                .await
                                .context("Failed to commit Go resolution output")?;

                            for edge in &go_resolve_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = go_resolve_output.nodes.len(),
                                edges = go_resolve_output.edges.len(),
                                "Go resolution complete"
                            );

                            go_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create Go resolve pool, skipping Go resolution: {e}"
                            );
                        }
                    }
                }
            }

            // 8g. Run Swift resolution (if Swift files were analyzed)
            if !swift_files.is_empty() {
                let swift_resolve_nodes = analyzer::collect_resolve_nodes_for_lang(&results, config::Language::Swift);
                if !swift_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = swift_resolve_nodes.len(),
                        "Running Swift resolution"
                    );

                    let swift_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.swift_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(swift_resolve_pool_config, 1) {
                        Ok(swift_resolve_pool) => {
                            let mut swift_resolve_output = plugin::run_resolve_with_nodes(
                                "swift-all",
                                &swift_resolve_nodes,
                                &[],
                                &swift_resolve_pool,
                            )
                            .await
                            .context("Swift resolution failed")?;
                            plugin::validate_plugin_output(&swift_resolve_output)?;
                            plugin::stamp_metadata(&mut swift_resolve_output, "swift-resolution", generation);

                            let swift_resolve_files: Vec<String> = swift_resolve_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&swift_resolve_files, &swift_resolve_output.nodes, &swift_resolve_output.edges, false)
                                .await
                                .context("Failed to commit Swift resolution output")?;

                            for edge in &swift_resolve_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = swift_resolve_output.nodes.len(),
                                edges = swift_resolve_output.edges.len(),
                                "Swift resolution complete"
                            );

                            swift_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create Swift resolve pool, skipping Swift resolution: {e}"
                            );
                        }
                    }
                }
            }

            // 8h. Run Apple cross-language resolution (if both Swift and Obj-C files present)
            let has_swift = !swift_files.is_empty();
            let has_objc = !objc_files.is_empty();
            if has_swift && has_objc {
                let mut all_apple_nodes = Vec::new();
                all_apple_nodes.extend(analyzer::collect_resolve_nodes_for_lang(&results, config::Language::Swift));
                all_apple_nodes.extend(analyzer::collect_resolve_nodes_for_lang(&results, config::Language::ObjectiveC));

                if !all_apple_nodes.is_empty() {
                    tracing::info!(
                        nodes = all_apple_nodes.len(),
                        "Running Apple cross-language resolution (Swift <-> Obj-C)"
                    );

                    let apple_cross_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.apple_cross_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(apple_cross_pool_config, 1) {
                        Ok(apple_cross_pool) => {
                            let mut apple_cross_output = plugin::run_resolve_with_nodes(
                                "apple-cross-all",
                                &all_apple_nodes,
                                &[],
                                &apple_cross_pool,
                            )
                            .await
                            .context("Apple cross-language resolution failed")?;
                            plugin::validate_plugin_output(&apple_cross_output)?;
                            plugin::stamp_metadata(&mut apple_cross_output, "apple-cross-resolution", generation);

                            let apple_cross_files: Vec<String> = apple_cross_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&apple_cross_files, &apple_cross_output.nodes, &apple_cross_output.edges, false)
                                .await
                                .context("Failed to commit Apple cross-language resolution output")?;

                            tracing::info!(
                                nodes = apple_cross_output.nodes.len(),
                                edges = apple_cross_output.edges.len(),
                                "Apple cross-language resolution complete"
                            );

                            apple_cross_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create Apple cross-resolve pool, skipping: {e}"
                            );
                        }
                    }
                }
            }

            // 8i. Run JVM cross-language resolution (Java <-> Kotlin, after both per-language resolvers)
            if !java_files.is_empty() && !kotlin_files.is_empty() {
                let jvm_resolve_nodes = query_resolve_nodes_for_jvm(&mut rfdb).await?;
                if !jvm_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = jvm_resolve_nodes.len(),
                        "Running JVM cross-language resolution (Java <-> Kotlin)"
                    );

                    let jvm_cross_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.jvm_cross_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(jvm_cross_resolve_pool_config, 1) {
                        Ok(jvm_cross_resolve_pool) => {
                            let mut jvm_cross_output = plugin::run_resolve_with_nodes(
                                "jvm-cross-all",
                                &jvm_resolve_nodes,
                                &[],
                                &jvm_cross_resolve_pool,
                            )
                            .await
                            .context("JVM cross-language resolution failed")?;
                            plugin::validate_plugin_output(&jvm_cross_output)?;
                            plugin::stamp_metadata(&mut jvm_cross_output, "jvm-cross-resolution", generation);
                            tag_virtual_nodes(&mut jvm_cross_output, "jvm-cross-resolution");

                            let jvm_cross_files: Vec<String> = jvm_cross_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&jvm_cross_files, &jvm_cross_output.nodes, &jvm_cross_output.edges, true)
                                .await
                                .context("Failed to commit JVM cross-language resolution output")?;

                            for edge in &jvm_cross_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = jvm_cross_output.nodes.len(),
                                edges = jvm_cross_output.edges.len(),
                                "JVM cross-language resolution complete"
                            );

                            jvm_cross_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create JVM cross-resolve pool, skipping cross-language resolution: {e}"
                            );
                        }
                    }
                }
            }

            // 8g.5. Run C/C++ resolution
            if !cpp_files.is_empty() {
                let cpp_resolve_nodes = query_resolve_nodes_for_lang(&mut rfdb, config::Language::Cpp).await?;
                if !cpp_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = cpp_resolve_nodes.len(),
                        "Running C/C++ resolution"
                    );

                    let cpp_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.cpp_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(cpp_resolve_pool_config, 1) {
                        Ok(cpp_resolve_pool) => {
                            let mut cpp_resolve_output = plugin::run_resolve_with_nodes(
                                "cpp-all",
                                &cpp_resolve_nodes,
                                &[],
                                &cpp_resolve_pool,
                            )
                            .await
                            .context("C/C++ resolution failed")?;
                            plugin::validate_plugin_output(&cpp_resolve_output)?;
                            plugin::stamp_metadata(&mut cpp_resolve_output, "cpp-resolution", generation);
                            tag_virtual_nodes(&mut cpp_resolve_output, "cpp-resolution");

                            let cpp_resolve_files: Vec<String> = cpp_resolve_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&cpp_resolve_files, &cpp_resolve_output.nodes, &cpp_resolve_output.edges, true)
                                .await
                                .context("Failed to commit C/C++ resolution output")?;

                            for edge in &cpp_resolve_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = cpp_resolve_output.nodes.len(),
                                edges = cpp_resolve_output.edges.len(),
                                "C/C++ resolution complete"
                            );

                            cpp_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create C/C++ resolve pool, skipping C/C++ resolution: {e}"
                            );
                        }
                    }
                }
            }

            // 8k. Run BEAM (Elixir/Erlang) resolution
            if !beam_files.is_empty() {
                let beam_resolve_nodes = analyzer::collect_resolve_nodes_for_lang(&results, config::Language::Beam);
                if !beam_resolve_nodes.is_empty() {
                    tracing::info!(
                        nodes = beam_resolve_nodes.len(),
                        "Running BEAM resolution"
                    );

                    let beam_resolve_pool_config = process_pool::PoolConfig {
                        command: cfg.analyzers.beam_resolve_path(),
                        args: vec!["--daemon".to_string()],
                        ..process_pool::PoolConfig::default()
                    };

                    match process_pool::ProcessPool::new(beam_resolve_pool_config, 1) {
                        Ok(beam_resolve_pool) => {
                            // Step 1: BEAM import resolution (alias/import/use/require → IMPORTS_FROM)
                            let mut beam_import_output = plugin::run_resolve_with_nodes(
                                "beam-imports",
                                &beam_resolve_nodes,
                                &[],
                                &beam_resolve_pool,
                            )
                            .await
                            .context("BEAM import resolution failed")?;
                            plugin::validate_plugin_output(&beam_import_output)?;
                            plugin::stamp_metadata(&mut beam_import_output, "beam-import-resolution", generation);

                            let beam_import_files: Vec<String> = beam_import_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&beam_import_files, &beam_import_output.nodes, &beam_import_output.edges, false)
                                .await
                                .context("Failed to commit BEAM import resolution output")?;

                            for edge in &beam_import_output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }

                            tracing::info!(
                                nodes = beam_import_output.nodes.len(),
                                edges = beam_import_output.edges.len(),
                                "BEAM import resolution complete"
                            );

                            // Step 2: BEAM local refs resolution
                            let mut beam_local_output = plugin::run_resolve_with_nodes(
                                "beam-local-refs",
                                &beam_resolve_nodes,
                                &[],
                                &beam_resolve_pool,
                            )
                            .await
                            .context("BEAM local refs resolution failed")?;
                            plugin::validate_plugin_output(&beam_local_output)?;
                            plugin::stamp_metadata(&mut beam_local_output, "beam-local-refs", generation);

                            let beam_local_files: Vec<String> = beam_local_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&beam_local_files, &beam_local_output.nodes, &beam_local_output.edges, false)
                                .await
                                .context("Failed to commit BEAM local refs output")?;

                            tracing::info!(
                                nodes = beam_local_output.nodes.len(),
                                edges = beam_local_output.edges.len(),
                                "BEAM local refs resolution complete"
                            );

                            beam_resolve_pool.shutdown().await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create BEAM resolve pool, skipping BEAM resolution: {e}"
                            );
                        }
                    }
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
            if !all_imports_from_edges.is_empty() {
                let mut depends_on_pairs: HashSet<(String, String)> = HashSet::new();

                for (src_id, dst_id) in &all_imports_from_edges {
                    // Extract file path from semantic ID: "path/to/file.ts->TYPE->name" → "path/to/file.ts"
                    let src_file = src_id.split("->").next().unwrap_or("");
                    let dst_file = dst_id.split("->").next().unwrap_or("");

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

            // Compact to deduplicate segments after all commits.
            // This is needed because:
            // 1. Re-analyzed files create new segment versions alongside old ones.
            //    The superseded_node/edge_count in the engine corrects node_count()
            //    for edges that go through the delete+readd path.
            // 2. DEPENDS_ON and other derived edges are committed with empty
            //    changed_files (no deletion phase), so old segment versions
            //    accumulate. Compaction deduplicates these by (src,dst,type) key.
            rfdb.compact().await.context("Failed to compact")?;

            // 10. Summary
            println!(
                "Analyzed {} files ({} JS, {} Haskell, {} Rust, {} Java, {} Kotlin, {} Python, {} Go, {} C/C++, {} BEAM, {} skipped): {} nodes, {} edges, {} errors",
                changed_files.len(),
                js_files.len(),
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
