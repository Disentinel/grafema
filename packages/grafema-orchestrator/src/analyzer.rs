//! Analysis spawning: parse with OXC -> pipe to grafema-analyzer -> ingest into RFDB.
//!
//! The pipeline for each file:
//! 1. Parse source with OXC (via `crate::parser::parse_file`) -> ESTree JSON
//! 2. Spawn `grafema-analyzer <filepath>`, pipe the JSON to stdin
//! 3. Read stdout as `FileAnalysis` JSON
//! 4. Convert to RFDB wire types (`WireNode`, `WireEdge`) for ingestion

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

use crate::parser;
use crate::process_pool::{PoolConfig, ProcessPool};
use crate::rfdb::{WireEdge, WireNode};

// ---------------------------------------------------------------------------
// Deserialization types — FileAnalysis from grafema-analyzer stdout
// ---------------------------------------------------------------------------

/// Parsed FileAnalysis from grafema-analyzer output.
#[derive(Debug, Deserialize)]
pub struct FileAnalysis {
    pub file: String,
    #[serde(rename = "moduleId")]
    pub module_id: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub exports: Vec<ExportInfo>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub name: String,
    pub file: String,
    pub line: i64,
    pub column: i64,
    pub exported: bool,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct GraphEdge {
    pub src: String,
    pub dst: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ExportInfo {
    pub name: String,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub kind: String,
    pub source: Option<String>,
}

// ---------------------------------------------------------------------------
// AnalysisResult — per-file outcome
// ---------------------------------------------------------------------------

/// Result of analyzing a single file. Contains either a successful `FileAnalysis`
/// or collected error messages (parse errors, analyzer failures, etc.).
/// Both fields may be populated: parse errors are collected even when a partial
/// AST produces a valid analysis.
pub struct AnalysisResult {
    pub file: PathBuf,
    pub analysis: Option<FileAnalysis>,
    pub errors: Vec<String>,
}

// ---------------------------------------------------------------------------
// Single-file analysis
// ---------------------------------------------------------------------------

/// Analyze a single file: parse with OXC, run grafema-analyzer, return FileAnalysis.
///
/// 1. Calls `parser::parse_file` to get ESTree JSON from OXC.
/// 2. Spawns `grafema-analyzer <filepath>` as a child process.
/// 3. Pipes the AST JSON to the child's stdin.
/// 4. Reads stdout and deserializes as `FileAnalysis`.
/// 5. Captures stderr for error diagnostics.
///
/// Returns `Err` if the file cannot be parsed at all, the analyzer binary
/// cannot be spawned, the analyzer exits non-zero, or its output is not
/// valid `FileAnalysis` JSON.
pub async fn analyze_file(file: &Path, ast_json: &str) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let mut child = tokio::process::Command::new("grafema-analyzer")
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn grafema-analyzer for {file_str}"))?;

    // Write AST JSON to stdin, then drop to close the pipe.
    {
        let stdin = child
            .stdin
            .as_mut()
            .context("Failed to open stdin for grafema-analyzer")?;
        stdin
            .write_all(ast_json.as_bytes())
            .await
            .with_context(|| format!("Failed to write AST to grafema-analyzer stdin for {file_str}"))?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close grafema-analyzer stdin for {file_str}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for grafema-analyzer for {file_str}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        anyhow::bail!(
            "grafema-analyzer exited with code {code} for {file_str}: {stderr}"
        );
    }

    let stdout = &output.stdout;
    let analysis: FileAnalysis = serde_json::from_slice(stdout).with_context(|| {
        let preview = String::from_utf8_lossy(&stdout[..stdout.len().min(200)]);
        format!(
            "Failed to parse grafema-analyzer output as FileAnalysis for {file_str}: {preview}"
        )
    })?;

    Ok(analysis)
}

// ---------------------------------------------------------------------------
// Daemon-mode analysis via ProcessPool
// ---------------------------------------------------------------------------

/// Response from grafema-analyzer in --daemon mode.
#[derive(Deserialize)]
struct DaemonResponse {
    status: String,
    result: Option<FileAnalysis>,
    error: Option<String>,
}

/// Analyze a single file via a persistent daemon process pool.
///
/// Builds a `{"file":"...","ast":...}` JSON request via string concatenation
/// (avoids parsing the AST into Value), sends it as a length-prefixed frame
/// through the pool, and parses the JSON response.
pub async fn analyze_file_pooled(
    pool: &ProcessPool,
    file: &Path,
    ast_json: &str,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    // Build JSON request by concatenation — no AST parsing needed.
    // The file path is JSON-escaped to handle special characters.
    let escaped_file = serde_json::to_string(&file_str)
        .with_context(|| format!("Failed to escape file path for {file_str}"))?;
    let payload = format!(r#"{{"file":{},"ast":{}}}"#, escaped_file, ast_json);

    let response_bytes = pool
        .request(payload.as_bytes())
        .await
        .with_context(|| format!("Pool request failed for {file_str}"))?;

    let response: DaemonResponse = serde_json::from_slice(&response_bytes)
        .with_context(|| format!("Failed to decode response for {file_str}"))?;

    match response.status.as_str() {
        "ok" => response
            .result
            .with_context(|| format!("Daemon returned ok but no result for {file_str}")),
        "error" => {
            let msg = response.error.unwrap_or_else(|| "unknown error".to_string());
            bail!("grafema-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown daemon response status '{other}' for {file_str}"),
    }
}

/// Analyze multiple files in parallel using persistent daemon processes.
///
/// Creates a `ProcessPool` with `grafema-analyzer --daemon` workers, parses
/// files with OXC, and sends ASTs through the pool. Falls back to
/// `analyze_files_parallel` if pool creation fails.
pub async fn analyze_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
) -> Vec<AnalysisResult> {
    let pool_config = PoolConfig {
        command: "grafema-analyzer".to_string(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let pool = match ProcessPool::new(pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!("Failed to create analyzer pool, falling back to spawn-per-file: {e}");
            return analyze_files_parallel(files, jobs).await;
        }
    };

    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let pool = Arc::clone(&pool);
            let file = file.clone();
            let file_display = file.display().to_string();

            tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .expect("Semaphore closed unexpectedly");

                tracing::info!("[{}/{}] Analyzing {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Step 1: Parse with OXC (CPU-bound -> spawn_blocking)
                let parse_result = {
                    let file_clone = file.clone();
                    tokio::task::spawn_blocking(move || parser::parse_file(&file_clone)).await
                };

                let ast_json = match parse_result {
                    Ok(Ok(result)) => {
                        if !result.errors.is_empty() {
                            for e in &result.errors {
                                errors.push(format!("Parse warning in {file_display}: {e}"));
                            }
                            tracing::warn!(
                                file = %file_display,
                                count = result.errors.len(),
                                "Parse errors (continuing with partial AST)"
                            );
                        }
                        result.json
                    }
                    Ok(Err(e)) => {
                        errors.push(format!("Parse failed for {file_display}: {e}"));
                        return AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                        };
                    }
                    Err(e) => {
                        errors.push(format!(
                            "Parse task panicked for {file_display}: {e}"
                        ));
                        return AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                        };
                    }
                };

                // Step 2: Send to daemon pool
                match analyze_file_pooled(&pool, &file, &ast_json).await {
                    Ok(analysis) => AnalysisResult {
                        file,
                        analysis: Some(analysis),
                        errors,
                    },
                    Err(e) => {
                        errors.push(format!(
                            "Analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                        }
                    }
                }
            })
        })
        .collect();

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(result) => results.push(result),
            Err(e) => {
                results.push(AnalysisResult {
                    file: PathBuf::new(),
                    analysis: None,
                    errors: vec![format!("Analysis task failed: {e}")],
                });
            }
        }
    }

    pool.shutdown().await;
    results
}

// ---------------------------------------------------------------------------
// Wire-type conversion
// ---------------------------------------------------------------------------

/// Convert `GraphNode` list from a `FileAnalysis` into RFDB `WireNode` format.
///
/// - `id` and `semantic_id` are both set to the node's semantic id string.
///   The RFDB server hashes these to u128 via BLAKE3.
/// - `metadata` is serialized to a JSON string (omitted when empty).
pub fn to_wire_nodes(analysis: &FileAnalysis) -> Vec<WireNode> {
    analysis
        .nodes
        .iter()
        .map(|node| {
            let metadata = if node.metadata.is_empty() {
                None
            } else {
                // Safe: HashMap<String, Value> always serializes successfully.
                Some(serde_json::to_string(&node.metadata).unwrap())
            };

            WireNode {
                id: node.id.clone(),
                semantic_id: Some(node.id.clone()),
                node_type: Some(node.node_type.clone()),
                name: Some(node.name.clone()),
                file: Some(node.file.clone()),
                exported: node.exported,
                metadata,
            }
        })
        .collect()
}

/// Convert `GraphEdge` list from a `FileAnalysis` into RFDB `WireEdge` format.
///
/// - `src` and `dst` are semantic id strings.
/// - `metadata` is serialized to a JSON string (omitted when empty).
pub fn to_wire_edges(analysis: &FileAnalysis) -> Vec<WireEdge> {
    analysis
        .edges
        .iter()
        .map(|edge| {
            let metadata = if edge.metadata.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&edge.metadata).unwrap())
            };

            WireEdge {
                src: edge.src.clone(),
                dst: edge.dst.clone(),
                edge_type: edge.edge_type.clone(),
                metadata,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Resolution node collection
// ---------------------------------------------------------------------------

/// Node types that the resolution plugin needs.
const RESOLVE_NODE_TYPES: &[&str] = &[
    "IMPORT_BINDING",
    "EXPORT_BINDING",
    "EXPORT",
    "FUNCTION",
    "VARIABLE",
    "CONSTANT",
    "CLASS",
];

/// Collect nodes relevant for cross-file resolution from analysis results.
///
/// Filters `GraphNode`s from successful analysis results, keeping only types
/// that the resolve daemon needs (imports, exports, declarations). Serializes
/// each node to `serde_json::Value` — the format grafema-resolve expects.
pub fn collect_resolve_nodes(results: &[AnalysisResult]) -> Vec<serde_json::Value> {
    results
        .iter()
        .filter_map(|r| r.analysis.as_ref())
        .flat_map(|a| &a.nodes)
        .filter(|n| RESOLVE_NODE_TYPES.contains(&n.node_type.as_str()))
        .filter_map(|n| serde_json::to_value(n).ok())
        .collect()
}

// ---------------------------------------------------------------------------
// Parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple files in parallel with bounded concurrency.
///
/// For each file:
/// 1. Parse with OXC (`crate::parser::parse_file`) — this is CPU-bound, run
///    in a blocking task so we don't starve the tokio runtime.
/// 2. If parsing fails entirely, record the error and skip analysis.
///    If parsing succeeds with errors, collect them but continue with the
///    partial AST (OXC always emits a partial AST).
/// 3. Spawn `grafema-analyzer` asynchronously, pipe the AST JSON.
/// 4. Collect `FileAnalysis` or error.
///
/// `jobs` controls the maximum number of concurrent analyses. A tokio
/// `Semaphore` enforces the bound. Progress is reported via `tracing::info`.
///
/// Failures in individual files do not stop other files from being analyzed.
pub async fn analyze_files_parallel(
    files: &[PathBuf],
    jobs: usize,
) -> Vec<AnalysisResult> {
    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let file = file.clone();
            let file_display = file.display().to_string();

            tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .expect("Semaphore closed unexpectedly");

                tracing::info!("[{}/{}] Analyzing {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Step 1: Parse with OXC (CPU-bound -> spawn_blocking)
                let parse_result = {
                    let file_clone = file.clone();
                    tokio::task::spawn_blocking(move || parser::parse_file(&file_clone)).await
                };

                let ast_json = match parse_result {
                    Ok(Ok(result)) => {
                        if !result.errors.is_empty() {
                            for e in &result.errors {
                                errors.push(format!("Parse warning in {file_display}: {e}"));
                            }
                            tracing::warn!(
                                file = %file_display,
                                count = result.errors.len(),
                                "Parse errors (continuing with partial AST)"
                            );
                        }
                        result.json
                    }
                    Ok(Err(e)) => {
                        errors.push(format!("Parse failed for {file_display}: {e}"));
                        return AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                        };
                    }
                    Err(e) => {
                        errors.push(format!(
                            "Parse task panicked for {file_display}: {e}"
                        ));
                        return AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                        };
                    }
                };

                // Step 2: Spawn grafema-analyzer
                match analyze_file(&file, &ast_json).await {
                    Ok(analysis) => AnalysisResult {
                        file,
                        analysis: Some(analysis),
                        errors,
                    },
                    Err(e) => {
                        errors.push(format!(
                            "Analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                        }
                    }
                }
            })
        })
        .collect();

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(result) => results.push(result),
            Err(e) => {
                // JoinError means the task panicked or was cancelled.
                // We still want to return something for ordering consistency.
                results.push(AnalysisResult {
                    file: PathBuf::new(),
                    analysis: None,
                    errors: vec![format!("Analysis task failed: {e}")],
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_analysis() -> FileAnalysis {
        FileAnalysis {
            file: "src/foo.js".to_string(),
            module_id: "src/foo.js".to_string(),
            nodes: vec![
                GraphNode {
                    id: "src/foo.js->FUNCTION->bar".to_string(),
                    node_type: "FUNCTION".to_string(),
                    name: "bar".to_string(),
                    file: "src/foo.js".to_string(),
                    line: 10,
                    column: 0,
                    exported: true,
                    metadata: {
                        let mut m = HashMap::new();
                        m.insert("async".to_string(), serde_json::Value::Bool(true));
                        m
                    },
                },
                GraphNode {
                    id: "src/foo.js->VARIABLE->x".to_string(),
                    node_type: "VARIABLE".to_string(),
                    name: "x".to_string(),
                    file: "src/foo.js".to_string(),
                    line: 1,
                    column: 6,
                    exported: false,
                    metadata: HashMap::new(),
                },
            ],
            edges: vec![
                GraphEdge {
                    src: "src/foo.js->FUNCTION->bar".to_string(),
                    dst: "src/foo.js->VARIABLE->x".to_string(),
                    edge_type: "REFERENCES".to_string(),
                    metadata: {
                        let mut m = HashMap::new();
                        m.insert("line".to_string(), serde_json::json!(12));
                        m
                    },
                },
                GraphEdge {
                    src: "src/foo.js->MODULE->src/foo.js".to_string(),
                    dst: "src/foo.js->FUNCTION->bar".to_string(),
                    edge_type: "CONTAINS".to_string(),
                    metadata: HashMap::new(),
                },
            ],
            exports: vec![ExportInfo {
                name: "bar".to_string(),
                node_id: "src/foo.js->FUNCTION->bar".to_string(),
                kind: "named".to_string(),
                source: None,
            }],
        }
    }

    #[test]
    fn to_wire_nodes_maps_all_fields() {
        let analysis = sample_analysis();
        let wire = to_wire_nodes(&analysis);

        assert_eq!(wire.len(), 2);

        // First node: exported function with metadata
        let n0 = &wire[0];
        assert_eq!(n0.id, "src/foo.js->FUNCTION->bar");
        assert_eq!(n0.semantic_id.as_deref(), Some("src/foo.js->FUNCTION->bar"));
        assert_eq!(n0.node_type.as_deref(), Some("FUNCTION"));
        assert_eq!(n0.name.as_deref(), Some("bar"));
        assert_eq!(n0.file.as_deref(), Some("src/foo.js"));
        assert!(n0.exported);
        assert!(n0.metadata.is_some());
        let meta: serde_json::Value =
            serde_json::from_str(n0.metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["async"], true);

        // Second node: non-exported variable without metadata
        let n1 = &wire[1];
        assert_eq!(n1.id, "src/foo.js->VARIABLE->x");
        assert!(!n1.exported);
        assert!(n1.metadata.is_none());
    }

    #[test]
    fn to_wire_edges_maps_all_fields() {
        let analysis = sample_analysis();
        let wire = to_wire_edges(&analysis);

        assert_eq!(wire.len(), 2);

        // First edge: with metadata
        let e0 = &wire[0];
        assert_eq!(e0.src, "src/foo.js->FUNCTION->bar");
        assert_eq!(e0.dst, "src/foo.js->VARIABLE->x");
        assert_eq!(e0.edge_type, "REFERENCES");
        assert!(e0.metadata.is_some());
        let meta: serde_json::Value =
            serde_json::from_str(e0.metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["line"], 12);

        // Second edge: without metadata
        let e1 = &wire[1];
        assert_eq!(e1.edge_type, "CONTAINS");
        assert!(e1.metadata.is_none());
    }

    #[test]
    fn to_wire_nodes_empty_analysis() {
        let analysis = FileAnalysis {
            file: "empty.js".to_string(),
            module_id: "empty.js".to_string(),
            nodes: vec![],
            edges: vec![],
            exports: vec![],
        };
        assert!(to_wire_nodes(&analysis).is_empty());
        assert!(to_wire_edges(&analysis).is_empty());
    }

    #[test]
    fn file_analysis_deserialize_from_json() {
        let json = r#"{
            "file": "test.js",
            "moduleId": "test.js",
            "nodes": [
                {
                    "id": "test.js->FUNCTION->foo",
                    "type": "FUNCTION",
                    "name": "foo",
                    "file": "test.js",
                    "line": 1,
                    "column": 0,
                    "exported": false
                }
            ],
            "edges": [
                {
                    "src": "a",
                    "dst": "b",
                    "type": "CALLS"
                }
            ],
            "exports": [
                {
                    "name": "foo",
                    "nodeId": "test.js->FUNCTION->foo",
                    "kind": "named",
                    "source": null
                }
            ]
        }"#;

        let analysis: FileAnalysis = serde_json::from_str(json).unwrap();
        assert_eq!(analysis.file, "test.js");
        assert_eq!(analysis.module_id, "test.js");
        assert_eq!(analysis.nodes.len(), 1);
        assert_eq!(analysis.nodes[0].node_type, "FUNCTION");
        assert_eq!(analysis.edges.len(), 1);
        assert_eq!(analysis.edges[0].edge_type, "CALLS");
        assert!(analysis.edges[0].metadata.is_empty());
        assert_eq!(analysis.exports.len(), 1);
        assert_eq!(analysis.exports[0].kind, "named");
    }

    #[test]
    fn daemon_request_json_concatenation() {
        let file_str = "src/test.js";
        let ast_json = r#"{"type":"Program","body":[]}"#;

        let escaped_file = serde_json::to_string(file_str).unwrap();
        let payload = format!(r#"{{"file":{},"ast":{}}}"#, escaped_file, ast_json);

        let decoded: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(decoded["file"], "src/test.js");
        assert_eq!(decoded["ast"]["type"], "Program");
    }

    #[test]
    fn daemon_response_ok_deserializes() {
        let json_str = r#"{
            "status": "ok",
            "result": {
                "file": "test.js",
                "moduleId": "test.js",
                "nodes": [],
                "edges": [],
                "exports": []
            }
        }"#;

        let response: DaemonResponse = serde_json::from_str(json_str).unwrap();

        assert_eq!(response.status, "ok");
        assert!(response.result.is_some());
        assert!(response.error.is_none());
    }

    #[test]
    fn daemon_response_error_deserializes() {
        let json_str = r#"{
            "status": "error",
            "error": "Parse error: unexpected token"
        }"#;

        let response: DaemonResponse = serde_json::from_str(json_str).unwrap();

        assert_eq!(response.status, "error");
        assert!(response.result.is_none());
        assert_eq!(
            response.error.as_deref(),
            Some("Parse error: unexpected token")
        );
    }

    #[test]
    fn collect_resolve_nodes_filters_by_type() {
        let results = vec![AnalysisResult {
            file: PathBuf::from("test.js"),
            analysis: Some(FileAnalysis {
                file: "test.js".to_string(),
                module_id: "test.js".to_string(),
                nodes: vec![
                    GraphNode {
                        id: "test.js->IMPORT_BINDING->foo".to_string(),
                        node_type: "IMPORT_BINDING".to_string(),
                        name: "foo".to_string(),
                        file: "test.js".to_string(),
                        line: 1,
                        column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                    },
                    GraphNode {
                        id: "test.js->FUNCTION->bar".to_string(),
                        node_type: "FUNCTION".to_string(),
                        name: "bar".to_string(),
                        file: "test.js".to_string(),
                        line: 5,
                        column: 0,
                        exported: true,
                        metadata: HashMap::new(),
                    },
                    GraphNode {
                        id: "test.js->REFERENCE->baz".to_string(),
                        node_type: "REFERENCE".to_string(),
                        name: "baz".to_string(),
                        file: "test.js".to_string(),
                        line: 10,
                        column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                    },
                    GraphNode {
                        id: "test.js->CALL->qux".to_string(),
                        node_type: "CALL".to_string(),
                        name: "qux".to_string(),
                        file: "test.js".to_string(),
                        line: 12,
                        column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                    },
                ],
                edges: vec![],
                exports: vec![],
            }),
            errors: vec![],
        }];

        let nodes = collect_resolve_nodes(&results);
        // Should include IMPORT_BINDING and FUNCTION, skip REFERENCE and CALL
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0]["type"], "IMPORT_BINDING");
        assert_eq!(nodes[1]["type"], "FUNCTION");
    }

    #[test]
    fn collect_resolve_nodes_skips_failed_analyses() {
        let results = vec![
            AnalysisResult {
                file: PathBuf::from("ok.js"),
                analysis: Some(FileAnalysis {
                    file: "ok.js".to_string(),
                    module_id: "ok.js".to_string(),
                    nodes: vec![GraphNode {
                        id: "ok.js->VARIABLE->x".to_string(),
                        node_type: "VARIABLE".to_string(),
                        name: "x".to_string(),
                        file: "ok.js".to_string(),
                        line: 1,
                        column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                    }],
                    edges: vec![],
                    exports: vec![],
                }),
                errors: vec![],
            },
            AnalysisResult {
                file: PathBuf::from("fail.js"),
                analysis: None,
                errors: vec!["parse failed".to_string()],
            },
        ];

        let nodes = collect_resolve_nodes(&results);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["name"], "x");
    }

    #[test]
    fn collect_resolve_nodes_empty_results() {
        let results: Vec<AnalysisResult> = vec![];
        let nodes = collect_resolve_nodes(&results);
        assert!(nodes.is_empty());
    }

    #[test]
    fn graph_node_serializes_with_type_field() {
        let node = GraphNode {
            id: "test.js->FUNCTION->foo".to_string(),
            node_type: "FUNCTION".to_string(),
            name: "foo".to_string(),
            file: "test.js".to_string(),
            line: 1,
            column: 0,
            exported: false,
            metadata: HashMap::new(),
        };
        let value = serde_json::to_value(&node).unwrap();
        // Should serialize node_type as "type" due to #[serde(rename = "type")]
        assert_eq!(value["type"], "FUNCTION");
        assert!(value.get("node_type").is_none());
    }
}
