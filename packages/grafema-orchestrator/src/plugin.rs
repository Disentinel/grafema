//! Plugin DAG runner: execute plugins in dependency order.
//!
//! Plugins declare dependencies via `depends_on`, forming a DAG (directed acyclic
//! graph). [`build_dag`] performs topological sort via Kahn's algorithm, grouping
//! plugins into execution levels — all plugins in a given level can theoretically
//! run in parallel.
//!
//! Two execution modes:
//! - **Streaming**: orchestrator queries RFDB, pipes results as NDJSON to plugin
//!   stdin, reads NDJSON emit commands from stdout.
//! - **Batch**: plugin receives `RFDB_SOCKET` / `RFDB_DATABASE` env vars and
//!   queries RFDB directly.

use crate::config::{PluginConfig, PluginMode};
use crate::process_pool::ProcessPool;
use crate::rfdb::{RfdbClient, WireEdge, WireNode};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Default timeout for plugins that don't specify one.
const DEFAULT_TIMEOUT_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// Parsed output from a streaming plugin.
#[derive(Debug, Default)]
pub struct PluginOutput {
    pub nodes: Vec<WireNode>,
    pub edges: Vec<WireEdge>,
}

/// Result of running a single plugin.
#[derive(Debug)]
pub struct PluginRunResult {
    pub plugin_name: String,
    pub nodes_emitted: usize,
    pub edges_emitted: usize,
    pub duration: Duration,
    pub error: Option<String>,
}

/// A single NDJSON line emitted by a streaming plugin.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PluginEmit {
    EmitNode(EmitNode),
    EmitEdge(EmitEdge),
}

#[derive(Debug, Deserialize)]
struct EmitNode {
    id: String,
    #[serde(default)]
    semantic_id: Option<String>,
    #[serde(default, alias = "nodeType")]
    node_type: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    exported: bool,
    #[serde(default)]
    metadata: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EmitEdge {
    src: String,
    dst: String,
    #[serde(alias = "edgeType")]
    edge_type: String,
    #[serde(default)]
    metadata: Option<String>,
}

/// Serializable Datalog result row for piping to plugin stdin.
#[derive(Serialize)]
struct DatalogRow {
    bindings: HashMap<String, serde_json::Value>,
}

// ---------------------------------------------------------------------------
// DAG building (Kahn's algorithm)
// ---------------------------------------------------------------------------

/// Build a DAG from plugin configs, return execution levels.
///
/// Each level contains plugins that can run in parallel — all dependencies
/// of level N plugins are satisfied by levels 0..N-1.
///
/// Returns an error if:
/// - A plugin references an unknown dependency
/// - The dependency graph contains a cycle
pub fn build_dag(plugins: &[PluginConfig]) -> Result<Vec<Vec<&PluginConfig>>> {
    if plugins.is_empty() {
        return Ok(vec![]);
    }

    // Build name -> index lookup
    let name_to_idx: HashMap<&str, usize> = plugins
        .iter()
        .enumerate()
        .map(|(i, p)| (p.name.as_str(), i))
        .collect();

    // Validate: all depends_on references exist
    for plugin in plugins {
        for dep in &plugin.depends_on {
            if !name_to_idx.contains_key(dep.as_str()) {
                bail!(
                    "Plugin '{}' depends on unknown plugin '{}'",
                    plugin.name,
                    dep
                );
            }
        }
    }

    // Build adjacency list and in-degree count
    let n = plugins.len();
    let mut in_degree = vec![0usize; n];
    let mut dependents: Vec<Vec<usize>> = vec![vec![]; n]; // dep -> list of plugins that depend on it

    for (i, plugin) in plugins.iter().enumerate() {
        in_degree[i] = plugin.depends_on.len();
        for dep in &plugin.depends_on {
            let dep_idx = name_to_idx[dep.as_str()];
            dependents[dep_idx].push(i);
        }
    }

    // Kahn's algorithm: BFS by levels
    let mut levels: Vec<Vec<&PluginConfig>> = Vec::new();
    let mut queue: VecDeque<usize> = VecDeque::new();
    let mut processed = 0usize;

    // Seed with zero-degree nodes
    for (i, &deg) in in_degree.iter().enumerate() {
        if deg == 0 {
            queue.push_back(i);
        }
    }

    while !queue.is_empty() {
        let level_size = queue.len();
        let mut level = Vec::with_capacity(level_size);

        for _ in 0..level_size {
            let idx = queue.pop_front().unwrap();
            level.push(&plugins[idx]);
            processed += 1;

            for &dependent in &dependents[idx] {
                in_degree[dependent] -= 1;
                if in_degree[dependent] == 0 {
                    queue.push_back(dependent);
                }
            }
        }

        levels.push(level);
    }

    if processed != n {
        // Cycle detected — find which plugins are involved
        let cycle_members: Vec<&str> = in_degree
            .iter()
            .enumerate()
            .filter(|(_, &deg)| deg > 0)
            .map(|(i, _)| plugins[i].name.as_str())
            .collect();
        bail!(
            "Dependency cycle detected among plugins: [{}]",
            cycle_members.join(", ")
        );
    }

    Ok(levels)
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

/// Validate plugin output: all IDs and edge types must be non-empty.
pub fn validate_plugin_output(output: &PluginOutput) -> Result<()> {
    for (i, node) in output.nodes.iter().enumerate() {
        if node.id.is_empty() {
            bail!("Node at index {} has an empty ID", i);
        }
    }
    for (i, edge) in output.edges.iter().enumerate() {
        if edge.src.is_empty() {
            bail!("Edge at index {} has an empty src", i);
        }
        if edge.dst.is_empty() {
            bail!("Edge at index {} has an empty dst", i);
        }
        if edge.edge_type.is_empty() {
            bail!("Edge at index {} has an empty edge_type", i);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Metadata stamping
// ---------------------------------------------------------------------------

/// Add `_source` and `_generation` to all node and edge metadata.
///
/// If existing metadata is present (JSON object), the fields are merged.
/// If metadata is absent or not a JSON object, a new object is created.
pub fn stamp_metadata(output: &mut PluginOutput, plugin_name: &str, generation: u64) {
    let stamp = |metadata: &mut Option<String>| {
        let mut obj = match metadata.as_deref() {
            Some(s) => serde_json::from_str::<serde_json::Value>(s)
                .ok()
                .and_then(|v| {
                    if v.is_object() {
                        Some(v)
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| serde_json::json!({})),
            None => serde_json::json!({}),
        };
        obj["_source"] = serde_json::json!(plugin_name);
        obj["_generation"] = serde_json::json!(generation);
        *metadata = Some(obj.to_string());
    };

    for node in &mut output.nodes {
        stamp(&mut node.metadata);
    }
    for edge in &mut output.edges {
        stamp(&mut edge.metadata);
    }
}

// ---------------------------------------------------------------------------
// Streaming plugin execution
// ---------------------------------------------------------------------------

/// Run a streaming-mode plugin.
///
/// 1. Query RFDB with the plugin's Datalog query
/// 2. Serialize results as NDJSON to plugin stdin
/// 3. Read NDJSON emit commands from plugin stdout
/// 4. Return buffered output (not yet committed)
pub async fn run_streaming_plugin(
    plugin: &PluginConfig,
    rfdb: &mut RfdbClient,
) -> Result<PluginOutput> {
    let query = plugin
        .query
        .as_deref()
        .context(format!(
            "Streaming plugin '{}' has no query configured",
            plugin.name
        ))?;

    // Query RFDB
    let results = rfdb.datalog_query(query).await.context(format!(
        "Failed to execute Datalog query for plugin '{}'",
        plugin.name
    ))?;

    // Spawn plugin process
    let parts: Vec<&str> = plugin.command.split_whitespace().collect();
    if parts.is_empty() {
        bail!("Plugin '{}' has an empty command", plugin.name);
    }

    let mut child = Command::new(parts[0])
        .args(&parts[1..])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context(format!(
            "Failed to spawn streaming plugin '{}'",
            plugin.name
        ))?;

    // Write NDJSON to stdin
    let mut stdin = child.stdin.take().context("Failed to open plugin stdin")?;
    for result in &results {
        let row = DatalogRow {
            bindings: result
                .bindings
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        };
        let mut line = serde_json::to_string(&row)?;
        line.push('\n');
        stdin.write_all(line.as_bytes()).await?;
    }
    drop(stdin); // Close stdin to signal EOF

    // Read NDJSON from stdout
    let stdout = child.stdout.take().context("Failed to open plugin stdout")?;
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut output = PluginOutput::default();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let emit: PluginEmit = serde_json::from_str(&line).context(format!(
            "Plugin '{}' emitted invalid NDJSON: {}",
            plugin.name, line
        ))?;

        match emit {
            PluginEmit::EmitNode(n) => {
                output.nodes.push(WireNode {
                    id: n.id,
                    semantic_id: n.semantic_id,
                    node_type: n.node_type,
                    name: n.name,
                    file: n.file,
                    exported: n.exported,
                    metadata: n.metadata,
                });
            }
            PluginEmit::EmitEdge(e) => {
                output.edges.push(WireEdge {
                    src: e.src,
                    dst: e.dst,
                    edge_type: e.edge_type,
                    metadata: e.metadata,
                });
            }
        }
    }

    // Wait for process to finish
    let status = child.wait().await?;
    if !status.success() {
        bail!(
            "Streaming plugin '{}' exited with status: {}",
            plugin.name,
            status
        );
    }

    Ok(output)
}

// ---------------------------------------------------------------------------
// Batch plugin execution
// ---------------------------------------------------------------------------

/// Run a batch-mode plugin.
///
/// Sets `RFDB_SOCKET` and `RFDB_DATABASE` environment variables, then spawns
/// the plugin command and waits for it to complete.
pub async fn run_batch_plugin(
    plugin: &PluginConfig,
    socket_path: &Path,
    db_name: &str,
) -> Result<()> {
    let parts: Vec<&str> = plugin.command.split_whitespace().collect();
    if parts.is_empty() {
        bail!("Plugin '{}' has an empty command", plugin.name);
    }

    let mut child = Command::new(parts[0])
        .args(&parts[1..])
        .env("RFDB_SOCKET", socket_path.as_os_str())
        .env("RFDB_DATABASE", db_name)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context(format!("Failed to spawn batch plugin '{}'", plugin.name))?;

    let status = child.wait().await?;
    if !status.success() {
        bail!(
            "Batch plugin '{}' exited with status: {}",
            plugin.name,
            status
        );
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Single plugin runner (dispatches by mode)
// ---------------------------------------------------------------------------

/// Run a single plugin with timeout, dispatching to streaming or batch mode.
///
/// For streaming plugins: validates output and stamps metadata before returning.
/// If a `resolve_pool` is provided, streaming plugins use the daemon pool
/// instead of spawning a new process.
/// For batch plugins: no output is captured (plugin writes directly to RFDB).
pub async fn run_plugin(
    plugin: &PluginConfig,
    rfdb: &mut RfdbClient,
    socket_path: &Path,
    db_name: &str,
    generation: u64,
    resolve_pool: Option<&ProcessPool>,
) -> Result<PluginRunResult> {
    let timeout_duration = plugin
        .timeout()
        .unwrap_or(Duration::from_secs(DEFAULT_TIMEOUT_SECS));

    let start = Instant::now();

    let result = tokio::time::timeout(timeout_duration, async {
        match plugin.mode {
            PluginMode::Streaming => {
                let mut output = match resolve_pool {
                    Some(pool) => run_streaming_plugin_pooled(plugin, rfdb, pool).await?,
                    None => run_streaming_plugin(plugin, rfdb).await?,
                };
                validate_plugin_output(&output)?;
                stamp_metadata(&mut output, &plugin.name, generation);

                // Commit to RFDB
                let changed_files: Vec<String> = output
                    .nodes
                    .iter()
                    .filter_map(|n| n.file.clone())
                    .collect::<HashSet<_>>()
                    .into_iter()
                    .collect();

                rfdb.commit_batch(&changed_files, &output.nodes, &output.edges, false)
                    .await
                    .context(format!(
                        "Failed to commit output of plugin '{}'",
                        plugin.name
                    ))?;

                Ok::<_, anyhow::Error>((output.nodes.len(), output.edges.len()))
            }
            PluginMode::Batch => {
                run_batch_plugin(plugin, socket_path, db_name).await?;
                Ok((0, 0))
            }
        }
    })
    .await;

    let duration = start.elapsed();

    match result {
        Ok(Ok((nodes, edges))) => Ok(PluginRunResult {
            plugin_name: plugin.name.clone(),
            nodes_emitted: nodes,
            edges_emitted: edges,
            duration,
            error: None,
        }),
        Ok(Err(e)) => Ok(PluginRunResult {
            plugin_name: plugin.name.clone(),
            nodes_emitted: 0,
            edges_emitted: 0,
            duration,
            error: Some(e.to_string()),
        }),
        Err(_elapsed) => Ok(PluginRunResult {
            plugin_name: plugin.name.clone(),
            nodes_emitted: 0,
            edges_emitted: 0,
            duration,
            error: Some(format!(
                "Plugin '{}' timed out after {:?}",
                plugin.name, timeout_duration
            )),
        }),
    }
}

// ---------------------------------------------------------------------------
// Pooled streaming plugin execution (daemon mode)
// ---------------------------------------------------------------------------

/// Workspace package info sent to the resolve daemon.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspacePackageWire {
    pub name: String,
    pub entry_point: String,
    pub package_dir: String,
}

/// Request sent to grafema-resolve in --daemon mode.
#[derive(Serialize)]
struct ResolveRequest {
    cmd: String,
    nodes: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    workspace_packages: Vec<WorkspacePackageWire>,
}

/// Response from grafema-resolve in --daemon mode.
#[derive(Deserialize)]
struct ResolveResponse {
    status: String,
    commands: Option<Vec<ResolveCommand>>,
    error: Option<String>,
}

/// A single command from grafema-resolve.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ResolveCommand {
    EmitNode(EmitNode),
    EmitEdge(EmitEdge),
}

/// Run a streaming plugin via the persistent resolve daemon pool.
///
/// 1. Query RFDB with the plugin's Datalog query
/// 2. Build a resolve daemon request from the query results
/// 3. Send through the pool, parse the response
/// 4. Convert to PluginOutput
pub async fn run_streaming_plugin_pooled(
    plugin: &PluginConfig,
    rfdb: &mut RfdbClient,
    resolve_pool: &ProcessPool,
) -> Result<PluginOutput> {
    let query = plugin
        .query
        .as_deref()
        .context(format!(
            "Streaming plugin '{}' has no query configured",
            plugin.name
        ))?;

    // Query RFDB
    let results = rfdb.datalog_query(query).await.context(format!(
        "Failed to execute Datalog query for plugin '{}'",
        plugin.name
    ))?;

    // Extract the subcommand from the plugin command (e.g., "grafema-resolve imports" → "imports")
    let cmd = plugin
        .command
        .split_whitespace()
        .last()
        .unwrap_or("unknown")
        .to_string();

    // Convert query results to node-shaped JSON values for the resolve daemon
    let nodes: Vec<serde_json::Value> = results
        .iter()
        .map(|r| serde_json::to_value(&r.bindings).unwrap_or_default())
        .collect();

    let request = ResolveRequest { cmd, nodes, workspace_packages: vec![] };
    let payload = rmp_serde::to_vec_named(&request).context(format!(
        "Failed to encode resolve request for plugin '{}'",
        plugin.name
    ))?;

    let response_bytes = resolve_pool
        .request(&payload)
        .await
        .context(format!(
            "Pool request failed for plugin '{}'",
            plugin.name
        ))?;

    let response: ResolveResponse = rmp_serde::from_slice(&response_bytes).context(format!(
        "Failed to decode resolve response for plugin '{}'",
        plugin.name
    ))?;

    if response.status != "ok" {
        let msg = response.error.unwrap_or_else(|| "unknown error".to_string());
        bail!(
            "Resolve daemon error for plugin '{}': {}",
            plugin.name,
            msg
        );
    }

    let mut output = PluginOutput::default();
    if let Some(commands) = response.commands {
        for cmd in commands {
            match cmd {
                ResolveCommand::EmitNode(n) => {
                    output.nodes.push(WireNode {
                        id: n.id,
                        semantic_id: n.semantic_id,
                        node_type: n.node_type,
                        name: n.name,
                        file: n.file,
                        exported: n.exported,
                        metadata: n.metadata,
                    });
                }
                ResolveCommand::EmitEdge(e) => {
                    output.edges.push(WireEdge {
                        src: e.src,
                        dst: e.dst,
                        edge_type: e.edge_type,
                        metadata: e.metadata,
                    });
                }
            }
        }
    }

    Ok(output)
}

// ---------------------------------------------------------------------------
// Direct resolution with in-memory nodes (bypasses RFDB Datalog round-trip)
// ---------------------------------------------------------------------------

/// Run a resolution command with pre-collected nodes, bypassing RFDB.
///
/// Instead of querying RFDB via Datalog and losing field names/types in the
/// round-trip, this sends the original `GraphNode` JSON values directly to
/// the resolve daemon pool.
///
/// # Arguments
/// * `cmd` - Resolution subcommand (e.g., "imports", "runtime-globals")
/// * `nodes` - Pre-collected `serde_json::Value` nodes from analysis results
/// * `workspace_packages` - Workspace package mapping for cross-package resolution
/// * `resolve_pool` - Persistent resolve daemon process pool
pub async fn run_resolve_with_nodes(
    cmd: &str,
    nodes: &[serde_json::Value],
    workspace_packages: &[WorkspacePackageWire],
    resolve_pool: &ProcessPool,
) -> Result<PluginOutput> {
    let request = ResolveRequest {
        cmd: cmd.to_string(),
        nodes: nodes.to_vec(),
        workspace_packages: workspace_packages.to_vec(),
    };

    let payload = rmp_serde::to_vec_named(&request)
        .context("Failed to encode resolve request")?;

    let response_bytes = resolve_pool
        .request(&payload)
        .await
        .context(format!("Pool request failed for resolve cmd '{cmd}'"))?;

    let response: ResolveResponse = rmp_serde::from_slice(&response_bytes)
        .context(format!("Failed to decode resolve response for cmd '{cmd}'"))?;

    if response.status != "ok" {
        let msg = response.error.unwrap_or_else(|| "unknown error".to_string());
        bail!("Resolve daemon error for cmd '{cmd}': {msg}");
    }

    let mut output = PluginOutput::default();
    if let Some(commands) = response.commands {
        for command in commands {
            match command {
                ResolveCommand::EmitNode(n) => {
                    output.nodes.push(WireNode {
                        id: n.id,
                        semantic_id: n.semantic_id,
                        node_type: n.node_type,
                        name: n.name,
                        file: n.file,
                        exported: n.exported,
                        metadata: n.metadata,
                    });
                }
                ResolveCommand::EmitEdge(e) => {
                    output.edges.push(WireEdge {
                        src: e.src,
                        dst: e.dst,
                        edge_type: e.edge_type,
                        metadata: e.metadata,
                    });
                }
            }
        }
    }

    Ok(output)
}

// ---------------------------------------------------------------------------
// Full DAG execution
// ---------------------------------------------------------------------------

/// Execute the full plugin DAG: build levels, run each level sequentially.
///
/// Within each level, plugins are run sequentially because `RfdbClient` requires
/// `&mut self` (not Send/Sync). For true parallelism, callers would need to
/// provide multiple client connections.
///
/// If `resolve_pool` is provided, streaming plugins use the persistent daemon
/// pool instead of spawning a new process per invocation.
///
/// For streaming plugins: output is validated, metadata-stamped, and committed.
/// Results for all plugins are collected and returned.
pub async fn run_plugins_dag(
    plugins: &[PluginConfig],
    rfdb: &mut RfdbClient,
    socket_path: &Path,
    db_name: &str,
    generation: u64,
    resolve_pool: Option<&ProcessPool>,
) -> Result<Vec<PluginRunResult>> {
    let levels = build_dag(plugins)?;
    let mut results = Vec::with_capacity(plugins.len());

    for (level_idx, level) in levels.iter().enumerate() {
        tracing::info!(
            level = level_idx,
            plugins = level.len(),
            "Executing DAG level"
        );

        for plugin in level {
            tracing::info!(plugin = %plugin.name, "Running plugin");
            let result = run_plugin(plugin, rfdb, socket_path, db_name, generation, resolve_pool).await?;

            if let Some(ref err) = result.error {
                tracing::error!(plugin = %result.plugin_name, error = %err, "Plugin failed");
            } else {
                tracing::info!(
                    plugin = %result.plugin_name,
                    nodes = result.nodes_emitted,
                    edges = result.edges_emitted,
                    duration_ms = result.duration.as_millis() as u64,
                    "Plugin completed"
                );
            }

            results.push(result);
        }
    }

    Ok(results)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PluginConfig;

    /// Helper: create a PluginConfig for testing.
    fn make_plugin(name: &str, deps: &[&str]) -> PluginConfig {
        PluginConfig {
            name: name.to_string(),
            command: format!("echo {}", name),
            query: None,
            depends_on: deps.iter().map(|s| s.to_string()).collect(),
            mode: PluginMode::Streaming,
            timeout_secs: None,
        }
    }

    // -- build_dag tests --

    #[test]
    fn build_dag_empty() {
        let plugins: Vec<PluginConfig> = vec![];
        let levels = build_dag(&plugins).unwrap();
        assert!(levels.is_empty());
    }

    #[test]
    fn build_dag_simple_chain() {
        // A -> B -> C (C depends on B, B depends on A)
        let plugins = vec![
            make_plugin("A", &[]),
            make_plugin("B", &["A"]),
            make_plugin("C", &["B"]),
        ];

        let levels = build_dag(&plugins).unwrap();
        assert_eq!(levels.len(), 3, "chain of 3 should produce 3 levels");
        assert_eq!(levels[0].len(), 1);
        assert_eq!(levels[0][0].name, "A");
        assert_eq!(levels[1].len(), 1);
        assert_eq!(levels[1][0].name, "B");
        assert_eq!(levels[2].len(), 1);
        assert_eq!(levels[2][0].name, "C");
    }

    #[test]
    fn build_dag_independent_plugins_same_level() {
        // A, B, C — no deps, all in level 0
        let plugins = vec![
            make_plugin("A", &[]),
            make_plugin("B", &[]),
            make_plugin("C", &[]),
        ];

        let levels = build_dag(&plugins).unwrap();
        assert_eq!(levels.len(), 1, "independent plugins should be in one level");
        assert_eq!(levels[0].len(), 3);

        let names: Vec<&str> = levels[0].iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"A"));
        assert!(names.contains(&"B"));
        assert!(names.contains(&"C"));
    }

    #[test]
    fn build_dag_diamond() {
        //    A
        //   / \
        //  B   C
        //   \ /
        //    D
        let plugins = vec![
            make_plugin("A", &[]),
            make_plugin("B", &["A"]),
            make_plugin("C", &["A"]),
            make_plugin("D", &["B", "C"]),
        ];

        let levels = build_dag(&plugins).unwrap();
        assert_eq!(levels.len(), 3);
        assert_eq!(levels[0].len(), 1);
        assert_eq!(levels[0][0].name, "A");
        assert_eq!(levels[1].len(), 2);
        let l1_names: Vec<&str> = levels[1].iter().map(|p| p.name.as_str()).collect();
        assert!(l1_names.contains(&"B"));
        assert!(l1_names.contains(&"C"));
        assert_eq!(levels[2].len(), 1);
        assert_eq!(levels[2][0].name, "D");
    }

    #[test]
    fn build_dag_cycle_detection() {
        // A -> B -> A (cycle)
        let plugins = vec![make_plugin("A", &["B"]), make_plugin("B", &["A"])];

        let err = build_dag(&plugins).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("cycle"), "Expected cycle error, got: {msg}");
        assert!(msg.contains("A"), "Cycle error should mention A: {msg}");
        assert!(msg.contains("B"), "Cycle error should mention B: {msg}");
    }

    #[test]
    fn build_dag_unknown_dependency() {
        let plugins = vec![make_plugin("A", &["nonexistent"])];

        let err = build_dag(&plugins).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("unknown plugin 'nonexistent'"),
            "Expected unknown dep error, got: {msg}"
        );
        assert!(
            msg.contains("Plugin 'A'"),
            "Error should mention the plugin name: {msg}"
        );
    }

    #[test]
    fn build_dag_self_dependency() {
        let plugins = vec![make_plugin("A", &["A"])];

        let err = build_dag(&plugins).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("cycle"), "Self-dep should be a cycle: {msg}");
    }

    // -- validate_plugin_output tests --

    #[test]
    fn validate_valid_output() {
        let output = PluginOutput {
            nodes: vec![WireNode {
                id: "node1".to_string(),
                semantic_id: None,
                node_type: Some("FUNCTION".to_string()),
                name: Some("foo".to_string()),
                file: Some("test.js".to_string()),
                exported: false,
                metadata: None,
            }],
            edges: vec![WireEdge {
                src: "node1".to_string(),
                dst: "node2".to_string(),
                edge_type: "CALLS".to_string(),
                metadata: None,
            }],
        };
        assert!(validate_plugin_output(&output).is_ok());
    }

    #[test]
    fn validate_empty_output() {
        let output = PluginOutput::default();
        assert!(validate_plugin_output(&output).is_ok());
    }

    #[test]
    fn validate_rejects_empty_node_id() {
        let output = PluginOutput {
            nodes: vec![WireNode {
                id: String::new(),
                semantic_id: None,
                node_type: None,
                name: None,
                file: None,
                exported: false,
                metadata: None,
            }],
            edges: vec![],
        };
        let err = validate_plugin_output(&output).unwrap_err();
        assert!(err.to_string().contains("empty ID"), "{}", err);
    }

    #[test]
    fn validate_rejects_empty_edge_src() {
        let output = PluginOutput {
            nodes: vec![],
            edges: vec![WireEdge {
                src: String::new(),
                dst: "node2".to_string(),
                edge_type: "CALLS".to_string(),
                metadata: None,
            }],
        };
        let err = validate_plugin_output(&output).unwrap_err();
        assert!(err.to_string().contains("empty src"), "{}", err);
    }

    #[test]
    fn validate_rejects_empty_edge_dst() {
        let output = PluginOutput {
            nodes: vec![],
            edges: vec![WireEdge {
                src: "node1".to_string(),
                dst: String::new(),
                edge_type: "CALLS".to_string(),
                metadata: None,
            }],
        };
        let err = validate_plugin_output(&output).unwrap_err();
        assert!(err.to_string().contains("empty dst"), "{}", err);
    }

    #[test]
    fn validate_rejects_empty_edge_type() {
        let output = PluginOutput {
            nodes: vec![],
            edges: vec![WireEdge {
                src: "node1".to_string(),
                dst: "node2".to_string(),
                edge_type: String::new(),
                metadata: None,
            }],
        };
        let err = validate_plugin_output(&output).unwrap_err();
        assert!(err.to_string().contains("empty edge_type"), "{}", err);
    }

    // -- stamp_metadata tests --

    #[test]
    fn stamp_metadata_adds_fields_to_empty() {
        let mut output = PluginOutput {
            nodes: vec![WireNode {
                id: "n1".to_string(),
                semantic_id: None,
                node_type: None,
                name: None,
                file: None,
                exported: false,
                metadata: None,
            }],
            edges: vec![WireEdge {
                src: "a".to_string(),
                dst: "b".to_string(),
                edge_type: "CALLS".to_string(),
                metadata: None,
            }],
        };

        stamp_metadata(&mut output, "test-plugin", 42);

        // Check node metadata
        let node_meta: serde_json::Value =
            serde_json::from_str(output.nodes[0].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(node_meta["_source"], "test-plugin");
        assert_eq!(node_meta["_generation"], 42);

        // Check edge metadata
        let edge_meta: serde_json::Value =
            serde_json::from_str(output.edges[0].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(edge_meta["_source"], "test-plugin");
        assert_eq!(edge_meta["_generation"], 42);
    }

    #[test]
    fn stamp_metadata_merges_with_existing() {
        let mut output = PluginOutput {
            nodes: vec![WireNode {
                id: "n1".to_string(),
                semantic_id: None,
                node_type: None,
                name: None,
                file: None,
                exported: false,
                metadata: Some(r#"{"line":10,"col":5}"#.to_string()),
            }],
            edges: vec![],
        };

        stamp_metadata(&mut output, "resolver", 7);

        let meta: serde_json::Value =
            serde_json::from_str(output.nodes[0].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["_source"], "resolver");
        assert_eq!(meta["_generation"], 7);
        assert_eq!(meta["line"], 10, "existing field should be preserved");
        assert_eq!(meta["col"], 5, "existing field should be preserved");
    }

    #[test]
    fn stamp_metadata_overwrites_non_object_metadata() {
        let mut output = PluginOutput {
            nodes: vec![WireNode {
                id: "n1".to_string(),
                semantic_id: None,
                node_type: None,
                name: None,
                file: None,
                exported: false,
                metadata: Some("\"not an object\"".to_string()),
            }],
            edges: vec![],
        };

        stamp_metadata(&mut output, "plugin-x", 1);

        let meta: serde_json::Value =
            serde_json::from_str(output.nodes[0].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["_source"], "plugin-x");
        assert_eq!(meta["_generation"], 1);
    }
}
