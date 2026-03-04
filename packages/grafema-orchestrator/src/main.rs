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

            let db_name = "grafema";
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

            // 4. Analyze changed files in parallel (OXC parse → grafema-analyzer daemon pool)
            let results = analyzer::analyze_files_parallel_pooled(&changed_files, jobs).await;

            // 5. Ingest results into RFDB (deferred indexing for performance)
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

                    let file_str = result.file.display().to_string();
                    rfdb.commit_batch(&[file_str], &wire_nodes, &wire_edges, true)
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

            // 6. Handle deleted files
            let deleted = gc::detect_deleted_files(&gen_tracker, &files);
            if !deleted.is_empty() {
                tracing::info!(count = deleted.len(), "Cleaning up deleted files");
                for del_file in &deleted {
                    let file_str = del_file.display().to_string();
                    rfdb.commit_batch(&[file_str], &[], &[], false).await?;
                }
            }

            // 7. Update mtime tracker for next incremental run
            gc::update_mtimes(&mut gen_tracker, &changed_files)?;

            // 8. Run resolution plugins with in-memory node data (bypasses RFDB round-trip)
            let resolve_nodes = analyzer::collect_resolve_nodes(&results);
            if !resolve_nodes.is_empty() {
                tracing::info!(
                    nodes = resolve_nodes.len(),
                    "Running built-in resolution with in-memory nodes"
                );

                let resolve_pool_config = process_pool::PoolConfig {
                    command: "grafema-resolve".to_string(),
                    args: vec!["--daemon".to_string()],
                    ..process_pool::PoolConfig::default()
                };

                match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(resolve_pool) => {
                        // Step 1: Import resolution
                        let mut import_output = plugin::run_resolve_with_nodes(
                            "imports",
                            &resolve_nodes,
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

                        resolve_pool.shutdown().await;
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to create resolve pool, skipping built-in resolution: {e}"
                        );
                    }
                }
            }

            // 8b. Run user-defined plugins via DAG (if any non-default plugins configured)
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
                    command: "grafema-resolve".to_string(),
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
                "Analyzed {} files ({} skipped): {} nodes, {} edges, {} errors",
                changed_files.len(),
                unchanged_files.len(),
                total_nodes,
                total_edges,
                total_errors
            );

            Ok(())
        }
    }
}
