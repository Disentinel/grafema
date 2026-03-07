use grafema_orchestrator::{analyzer, config, discovery, gc, plugin, process_pool, rfdb};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

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
            let ws_packages: Vec<plugin::WorkspacePackageWire> = ws_packages_raw
                .iter()
                .map(|p| plugin::WorkspacePackageWire {
                    name: p.name.clone(),
                    entry_point: p.entry_point.clone(),
                    package_dir: p.package_dir.clone(),
                })
                .collect();
            if !ws_packages.is_empty() {
                tracing::info!(
                    count = ws_packages.len(),
                    "Discovered workspace packages for cross-package resolution"
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
            let (js_files, hs_files, rs_files, java_files, kotlin_files) = config::partition_by_language(&changed_files);
            tracing::info!(
                js = js_files.len(),
                haskell = hs_files.len(),
                rust = rs_files.len(),
                java = java_files.len(),
                kotlin = kotlin_files.len(),
                "Partitioned files by language"
            );

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

            // 5. Relativize paths: convert absolute → relative (to project root)
            //    VS Code and CLI query with relative paths, so RFDB must store relative paths.
            let root_str = cfg.root.display().to_string();
            for result in &mut results {
                if let Some(ref mut analysis) = result.analysis {
                    analysis.relativize_paths(&root_str);
                    analysis.ensure_function_contains_edges();
                }
            }

            // 6. Ingest results into RFDB (deferred indexing for performance)
            let mut total_nodes = 0usize;
            let mut total_edges = 0usize;
            let mut total_errors = 0usize;

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

                    // Use relativized path for commit_batch file key
                    let file_str = &analysis.file;
                    rfdb.commit_batch(&[file_str.clone()], &wire_nodes, &wire_edges, true)
                        .await
                        .with_context(|| {
                            format!("Failed to commit batch for {}", result.file.display())
                        })?;
                }
            }

            // Rebuild indexes once after all deferred commits
            rfdb.rebuild_indexes().await.context("Failed to rebuild indexes")?;

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

            // 8. Run resolution plugins with in-memory node data (bypasses RFDB round-trip)
            let resolve_nodes = analyzer::collect_resolve_nodes_for_lang(&results, config::Language::JavaScript);
            if !resolve_nodes.is_empty() {
                tracing::info!(
                    nodes = resolve_nodes.len(),
                    "Running built-in resolution with in-memory nodes"
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

                        let import_files: Vec<String> = import_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&import_files, &import_output.nodes, &import_output.edges, false)
                            .await
                            .context("Failed to commit import resolution output")?;

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

                        let globals_files: Vec<String> = globals_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&globals_files, &globals_output.nodes, &globals_output.edges, false)
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

                        let builtins_files: Vec<String> = builtins_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&builtins_files, &builtins_output.nodes, &builtins_output.edges, false)
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

                        let cross_file_files: Vec<String> = cross_file_output
                            .nodes
                            .iter()
                            .filter_map(|n| n.file.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect();
                        rfdb.commit_batch(&cross_file_files, &cross_file_output.nodes, &cross_file_output.edges, false)
                            .await
                            .context("Failed to commit cross-file CALLS output")?;

                        tracing::info!(
                            nodes = cross_file_output.nodes.len(),
                            edges = cross_file_output.edges.len(),
                            "Cross-file CALLS resolution complete"
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
                let hs_resolve_nodes = analyzer::collect_resolve_nodes_for_lang(&results, config::Language::Haskell);
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

                            let hs_import_files: Vec<String> = hs_import_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&hs_import_files, &hs_import_output.nodes, &hs_import_output.edges, false)
                                .await
                                .context("Failed to commit Haskell import resolution output")?;

                            tracing::info!(
                                nodes = hs_import_output.nodes.len(),
                                edges = hs_import_output.edges.len(),
                                "Haskell import resolution complete"
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
                let rs_resolve_nodes = analyzer::collect_resolve_nodes_for_lang(&results, config::Language::Rust);
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

                            let rs_import_files: Vec<String> = rs_import_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&rs_import_files, &rs_import_output.nodes, &rs_import_output.edges, false)
                                .await
                                .context("Failed to commit Rust import resolution output")?;

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
                let java_resolve_nodes = analyzer::collect_resolve_nodes_for_lang(&results, config::Language::Java);
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

                            let java_resolve_files: Vec<String> = java_resolve_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&java_resolve_files, &java_resolve_output.nodes, &java_resolve_output.edges, false)
                                .await
                                .context("Failed to commit Java resolution output")?;

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
                let kotlin_resolve_nodes = analyzer::collect_resolve_nodes_for_lang(&results, config::Language::Kotlin);
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

                            let kotlin_resolve_files: Vec<String> = kotlin_resolve_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&kotlin_resolve_files, &kotlin_resolve_output.nodes, &kotlin_resolve_output.edges, false)
                                .await
                                .context("Failed to commit Kotlin resolution output")?;

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

            // 8e. Run JVM cross-language resolution (Java <-> Kotlin, after both per-language resolvers)
            if !java_files.is_empty() && !kotlin_files.is_empty() {
                let jvm_resolve_nodes = analyzer::collect_resolve_nodes_for_jvm(&results);
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

                            let jvm_cross_files: Vec<String> = jvm_cross_output
                                .nodes
                                .iter()
                                .filter_map(|n| n.file.clone())
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .collect();
                            rfdb.commit_batch(&jvm_cross_files, &jvm_cross_output.nodes, &jvm_cross_output.edges, false)
                                .await
                                .context("Failed to commit JVM cross-language resolution output")?;

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

            // 8f. Run user-defined plugins via DAG (if any non-default plugins configured)
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

            // 9. Summary
            println!(
                "Analyzed {} files ({} JS, {} Haskell, {} Rust, {} Java, {} Kotlin, {} skipped): {} nodes, {} edges, {} errors",
                changed_files.len(),
                js_files.len(),
                hs_files.len(),
                rs_files.len(),
                java_files.len(),
                kotlin_files.len(),
                unchanged_files.len(),
                total_nodes,
                total_edges,
                total_errors
            );

            Ok(())
        }
    }
}
