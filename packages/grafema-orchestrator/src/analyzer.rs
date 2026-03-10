//! Analysis spawning: parse with OXC -> pipe to grafema-analyzer -> ingest into RFDB.
//!
//! The pipeline for each JS/TS file:
//! 1. Parse source with OXC (via `crate::parser::parse_file`) -> ESTree JSON
//! 2. Spawn `grafema-analyzer <filepath>`, pipe the JSON to stdin
//! 3. Read stdout as `FileAnalysis` JSON
//! 4. Convert to RFDB wire types (`WireNode`, `WireEdge`) for ingestion
//!
//! The pipeline for each Haskell file:
//! 1. Read source from disk (no OXC step — haskell-analyzer parses internally via ghc-lib-parser)
//! 2. Spawn `haskell-analyzer <filepath>`, pipe `{"file":"...","source":"..."}` to stdin
//! 3. Read stdout as `FileAnalysis` JSON (same output format as JS analyzer)
//! 4. Convert to RFDB wire types (`WireNode`, `WireEdge`) for ingestion

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
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
    #[serde(rename = "endLine", default)]
    pub end_line: i64,
    #[serde(rename = "endColumn", default)]
    pub end_column: i64,
    pub exported: bool,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
    /// Extra top-level fields from analyzer output not captured by declared fields.
    #[serde(flatten, default)]
    pub extra: HashMap<String, serde_json::Value>,
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

impl FileAnalysis {
    /// Strip an absolute root prefix from all paths (file fields, node IDs, edge src/dst).
    ///
    /// The graph consumers (VS Code extension, CLI) query with relative paths,
    /// so we must store relative paths in RFDB.
    pub fn relativize_paths(&mut self, root: &str) {
        let prefix = if root.ends_with('/') {
            root.to_string()
        } else {
            format!("{root}/")
        };
        // Strip root prefix from paths, handling "TYPE#/abs/path" patterns
        // like "MODULE#/Users/x/project/src/app.ts" → "MODULE#src/app.ts"
        let strip = |s: &str| -> String {
            if let Some(hash_pos) = s.find('#') {
                let (tag, rest) = s.split_at(hash_pos + 1); // "MODULE#" + "/abs/path"
                if let Some(stripped) = rest.strip_prefix(&prefix) {
                    return format!("{tag}{stripped}");
                }
            }
            s.strip_prefix(&prefix).unwrap_or(s).to_string()
        };
        self.file = strip(&self.file);
        self.module_id = strip(&self.module_id);
        for node in &mut self.nodes {
            node.id = strip(&node.id);
            node.file = strip(&node.file);
        }
        for edge in &mut self.edges {
            edge.src = strip(&edge.src);
            edge.dst = strip(&edge.dst);
        }
        for export in &mut self.exports {
            export.node_id = strip(&export.node_id);
        }
    }

    /// Ensure every FUNCTION node has at least one incoming CONTAINS edge.
    ///
    /// The JS/TS analyzer only emits MODULE→CONTAINS→FUNCTION for `FunctionDeclaration`
    /// AST nodes. Expression functions (`const f = function() {}`) and arrow functions
    /// (`const f = () => {}`) are missing these edges. This post-processing step adds
    /// MODULE→CONTAINS edges for any FUNCTION node not already a CONTAINS destination.
    pub fn ensure_function_contains_edges(&mut self) {
        let contains_dsts: HashSet<String> = self
            .edges
            .iter()
            .filter(|e| e.edge_type == "CONTAINS")
            .map(|e| e.dst.clone())
            .collect();

        let new_edges: Vec<GraphEdge> = self
            .nodes
            .iter()
            .filter(|n| n.node_type == "FUNCTION" && !contains_dsts.contains(&n.id))
            .map(|n| GraphEdge {
                src: self.module_id.clone(),
                dst: n.id.clone(),
                edge_type: "CONTAINS".to_string(),
                metadata: HashMap::new(),
            })
            .collect();

        self.edges.extend(new_edges);
    }
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
pub async fn analyze_file(file: &Path, ast_json: &str, analyzer_bin: &str) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let mut child = tokio::process::Command::new(analyzer_bin)
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
// Haskell single-file analysis
// ---------------------------------------------------------------------------

/// Analyze a single Haskell file: read source, run haskell-analyzer, return FileAnalysis.
///
/// Unlike JS analysis, there is no OXC parsing step — `haskell-analyzer` parses
/// internally via ghc-lib-parser. The payload sent to stdin is
/// `{"file":"<filepath>","source":"<source_text>"}` (raw source, not an AST).
///
/// Returns `Err` if the file cannot be read, the analyzer binary cannot be
/// spawned, the analyzer exits non-zero, or its output is not valid
/// `FileAnalysis` JSON.
pub async fn analyze_haskell_file(file: &Path, analyzer_bin: &str) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Haskell source file {file_str}"))?;

    let mut child = tokio::process::Command::new(analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn haskell-analyzer for {file_str}"))?;

    // Build JSON payload: {"file":"...","source":"..."}
    let payload = serde_json::json!({
        "file": file_str,
        "source": source,
    });

    {
        let stdin = child
            .stdin
            .as_mut()
            .context("Failed to open stdin for haskell-analyzer")?;
        stdin
            .write_all(payload.to_string().as_bytes())
            .await
            .with_context(|| {
                format!("Failed to write source to haskell-analyzer stdin for {file_str}")
            })?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close haskell-analyzer stdin for {file_str}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for haskell-analyzer for {file_str}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        anyhow::bail!(
            "haskell-analyzer exited with code {code} for {file_str}: {stderr}"
        );
    }

    let stdout = &output.stdout;
    let analysis: FileAnalysis = serde_json::from_slice(stdout).with_context(|| {
        let preview = String::from_utf8_lossy(&stdout[..stdout.len().min(200)]);
        format!(
            "Failed to parse haskell-analyzer output as FileAnalysis for {file_str}: {preview}"
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

/// Analyze a single Haskell file via a persistent daemon process pool.
///
/// Reads the source file from disk, builds a `{"file":"...","source":"..."}`
/// JSON request via string concatenation (avoids parsing the source into Value),
/// sends it as a length-prefixed frame through the pool, and parses the JSON
/// response.
pub async fn analyze_haskell_file_pooled(
    pool: &ProcessPool,
    file: &Path,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Haskell source file {file_str}"))?;

    // Build JSON request by concatenation — both file path and source are JSON-escaped.
    let escaped_file = serde_json::to_string(&file_str)
        .with_context(|| format!("Failed to escape file path for {file_str}"))?;
    let escaped_source = serde_json::to_string(&source)
        .with_context(|| format!("Failed to escape source for {file_str}"))?;
    let payload = format!(
        r#"{{"file":{},"source":{}}}"#,
        escaped_file, escaped_source
    );

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
            bail!("haskell-analyzer daemon error for {file_str}: {msg}")
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
    analyzers: &crate::config::AnalyzerBinaries,
) -> Vec<AnalysisResult> {
    let pool_config = PoolConfig {
        command: analyzers.js_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let pool = match ProcessPool::new(pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!("Failed to create analyzer pool, falling back to spawn-per-file: {e}");
            return analyze_files_parallel(files, jobs, &analyzers.js_path()).await;
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
// Haskell parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple Haskell files in parallel using persistent daemon processes.
///
/// Creates a `ProcessPool` with `haskell-analyzer --daemon` workers, reads
/// source files from disk, and sends them through the pool. Falls back to
/// `analyze_haskell_files_parallel` if pool creation fails.
pub async fn analyze_haskell_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Vec<AnalysisResult> {
    let pool_config = PoolConfig {
        command: analyzers.haskell_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let pool = match ProcessPool::new(pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create haskell-analyzer pool, falling back to spawn-per-file: {e}"
            );
            return analyze_haskell_files_parallel(files, jobs, &analyzers.haskell_path()).await;
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

                tracing::info!(
                    "[{}/{}] Analyzing Haskell file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                // No OXC parsing step — send source directly to haskell-analyzer
                match analyze_haskell_file_pooled(&pool, &file).await {
                    Ok(analysis) => AnalysisResult {
                        file,
                        analysis: Some(analysis),
                        errors,
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Haskell analyzer failed for {file_display}: {e}"
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
                    errors: vec![format!("Haskell analysis task failed: {e}")],
                });
            }
        }
    }

    pool.shutdown().await;
    results
}

/// Analyze multiple Haskell files in parallel with bounded concurrency (spawn mode).
///
/// For each file:
/// 1. Read source from disk (no OXC parsing — haskell-analyzer parses internally)
/// 2. Spawn `haskell-analyzer` asynchronously, pipe the source JSON
/// 3. Collect `FileAnalysis` or error
///
/// `jobs` controls the maximum number of concurrent analyses. A tokio
/// `Semaphore` enforces the bound. Failures in individual files do not stop
/// other files from being analyzed.
pub async fn analyze_haskell_files_parallel(
    files: &[PathBuf],
    jobs: usize,
    analyzer_bin: &str,
) -> Vec<AnalysisResult> {
    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();
    let analyzer_bin = analyzer_bin.to_string();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let file = file.clone();
            let file_display = file.display().to_string();
            let bin = analyzer_bin.clone();

            tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .expect("Semaphore closed unexpectedly");

                tracing::info!(
                    "[{}/{}] Analyzing Haskell file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_haskell_file(&file, &bin).await {
                    Ok(analysis) => AnalysisResult {
                        file,
                        analysis: Some(analysis),
                        errors,
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Haskell analyzer failed for {file_display}: {e}"
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
                    errors: vec![format!("Haskell analysis task failed: {e}")],
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Rust single-file analysis
// ---------------------------------------------------------------------------

/// Analyze a single Rust file: parse with syn (via rust_parser), run grafema-rust-analyzer.
///
/// Pipeline:
/// 1. Parse .rs file with syn (in orchestrator via crate::rust_parser) -> AST JSON
/// 2. Spawn `grafema-rust-analyzer`, pipe {"file":"...","ast":...} to stdin
/// 3. Read stdout as FileAnalysis JSON
pub async fn analyze_rust_file(file: &Path, ast_json: &str, analyzer_bin: &str) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let mut child = tokio::process::Command::new(analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn grafema-rust-analyzer for {file_str}"))?;

    let payload = serde_json::json!({
        "file": file_str,
        "ast": serde_json::from_str::<serde_json::Value>(ast_json)
            .unwrap_or(serde_json::Value::Null),
    });

    {
        let stdin = child.stdin.as_mut()
            .context("Failed to open stdin for grafema-rust-analyzer")?;
        stdin.write_all(payload.to_string().as_bytes()).await
            .with_context(|| format!("Failed to write AST to grafema-rust-analyzer stdin for {file_str}"))?;
        stdin.shutdown().await
            .with_context(|| format!("Failed to close grafema-rust-analyzer stdin for {file_str}"))?;
    }

    let output = child.wait_with_output().await
        .with_context(|| format!("Failed to wait for grafema-rust-analyzer for {file_str}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        anyhow::bail!("grafema-rust-analyzer exited with code {code} for {file_str}: {stderr}");
    }

    let stdout = &output.stdout;
    let analysis: FileAnalysis = serde_json::from_slice(stdout).with_context(|| {
        let preview = String::from_utf8_lossy(&stdout[..stdout.len().min(200)]);
        format!("Failed to parse grafema-rust-analyzer output for {file_str}: {preview}")
    })?;

    Ok(analysis)
}

// ---------------------------------------------------------------------------
// Rust daemon-mode analysis via ProcessPool
// ---------------------------------------------------------------------------

/// Analyze a single Rust file via a persistent daemon process pool.
///
/// Parses .rs file with syn (crate::rust_parser), sends AST JSON through pool.
pub async fn analyze_rust_file_pooled(
    pool: &ProcessPool,
    file: &Path,
    ast_json: &str,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

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
            bail!("grafema-rust-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown daemon response status '{other}' for {file_str}"),
    }
}

// ---------------------------------------------------------------------------
// Rust parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple Rust files in parallel using persistent daemon processes.
pub async fn analyze_rust_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Vec<AnalysisResult> {
    let pool_config = PoolConfig {
        command: analyzers.rust_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let pool = match ProcessPool::new(pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create grafema-rust-analyzer pool, falling back to spawn-per-file: {e}"
            );
            return analyze_rust_files_parallel(files, jobs, &analyzers.rust_path()).await;
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
                let _permit = sem.acquire().await.expect("Semaphore closed unexpectedly");
                tracing::info!("[{}/{}] Analyzing Rust file {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Step 1: Parse with syn (CPU-bound -> spawn_blocking)
                let parse_result = {
                    let file_clone = file.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::rust_parser::parse_rust_file(&file_clone)
                    }).await
                };

                let ast_json = match parse_result {
                    Ok(Ok(json)) => json,
                    Ok(Err(e)) => {
                        errors.push(format!("Rust parse failed for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors };
                    }
                    Err(e) => {
                        errors.push(format!("Rust parse task panicked for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors };
                    }
                };

                // Step 2: Send to daemon pool
                match analyze_rust_file_pooled(&pool, &file, &ast_json).await {
                    Ok(analysis) => AnalysisResult { file, analysis: Some(analysis), errors },
                    Err(e) => {
                        errors.push(format!("Rust analyzer failed for {file_display}: {e}"));
                        AnalysisResult { file, analysis: None, errors }
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
                    errors: vec![format!("Rust analysis task failed: {e}")],
                });
            }
        }
    }

    pool.shutdown().await;
    results
}

/// Analyze multiple Rust files in parallel with bounded concurrency (spawn mode).
pub async fn analyze_rust_files_parallel(
    files: &[PathBuf],
    jobs: usize,
    analyzer_bin: &str,
) -> Vec<AnalysisResult> {
    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();
    let analyzer_bin = analyzer_bin.to_string();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let file = file.clone();
            let file_display = file.display().to_string();
            let bin = analyzer_bin.clone();

            tokio::spawn(async move {
                let _permit = sem.acquire().await.expect("Semaphore closed unexpectedly");
                tracing::info!("[{}/{}] Analyzing Rust file {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Step 1: Parse with syn
                let ast_json = match crate::rust_parser::parse_rust_file(&file) {
                    Ok(json) => json,
                    Err(e) => {
                        errors.push(format!("Rust parse failed for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors };
                    }
                };

                // Step 2: Spawn analyzer
                match analyze_rust_file(&file, &ast_json, &bin).await {
                    Ok(analysis) => AnalysisResult { file, analysis: Some(analysis), errors },
                    Err(e) => {
                        errors.push(format!("Rust analyzer failed for {file_display}: {e}"));
                        AnalysisResult { file, analysis: None, errors }
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
                    errors: vec![format!("Rust analysis task failed: {e}")],
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Java single-file analysis (two-step: java-parser → java-analyzer)
// ---------------------------------------------------------------------------

/// Analyze a single Java file: read source, parse with java-parser, analyze with java-analyzer.
///
/// Pipeline:
/// 1. Read `.java` source from disk
/// 2. Send `{"file":"...","source":"..."}` to java-parser → receive `{"status":"ok","ast":{...}}`
/// 3. Send `{"file":"...","ast":...}` to java-analyzer → receive FileAnalysis
pub async fn analyze_java_file(
    file: &Path,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Java source file {file_str}"))?;

    // Step 1: Parse with java-parser
    let parser_bin = analyzers.java_parser_path();
    let mut parser_child = tokio::process::Command::new(&parser_bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn java-parser for {file_str}"))?;

    let parser_payload = serde_json::json!({
        "file": file_str,
        "source": source,
    });

    {
        let stdin = parser_child
            .stdin
            .as_mut()
            .context("Failed to open stdin for java-parser")?;
        stdin
            .write_all(parser_payload.to_string().as_bytes())
            .await
            .with_context(|| format!("Failed to write source to java-parser stdin for {file_str}"))?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close java-parser stdin for {file_str}"))?;
    }

    let parser_output = parser_child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for java-parser for {file_str}"))?;

    if !parser_output.status.success() {
        let stderr = String::from_utf8_lossy(&parser_output.stderr);
        let code = parser_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("java-parser exited with code {code} for {file_str}: {stderr}");
    }

    // Extract AST from parser response
    let parser_response: serde_json::Value =
        serde_json::from_slice(&parser_output.stdout).with_context(|| {
            let preview =
                String::from_utf8_lossy(&parser_output.stdout[..parser_output.stdout.len().min(200)]);
            format!("Failed to parse java-parser output for {file_str}: {preview}")
        })?;

    if parser_response.get("status").and_then(|s| s.as_str()) != Some("ok") {
        let err = parser_response
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown error");
        bail!("java-parser error for {file_str}: {err}");
    }

    let ast = parser_response
        .get("ast")
        .with_context(|| format!("java-parser returned ok but no ast for {file_str}"))?;

    // Step 2: Analyze with java-analyzer
    let analyzer_bin = analyzers.java_path();
    let mut analyzer_child = tokio::process::Command::new(&analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn java-analyzer for {file_str}"))?;

    let analyzer_payload = serde_json::json!({
        "file": file_str,
        "ast": ast,
    });

    {
        let stdin = analyzer_child
            .stdin
            .as_mut()
            .context("Failed to open stdin for java-analyzer")?;
        stdin
            .write_all(analyzer_payload.to_string().as_bytes())
            .await
            .with_context(|| {
                format!("Failed to write AST to java-analyzer stdin for {file_str}")
            })?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close java-analyzer stdin for {file_str}"))?;
    }

    let analyzer_output = analyzer_child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for java-analyzer for {file_str}"))?;

    if !analyzer_output.status.success() {
        let stderr = String::from_utf8_lossy(&analyzer_output.stderr);
        let code = analyzer_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("java-analyzer exited with code {code} for {file_str}: {stderr}");
    }

    let analysis: FileAnalysis =
        serde_json::from_slice(&analyzer_output.stdout).with_context(|| {
            let preview = String::from_utf8_lossy(
                &analyzer_output.stdout[..analyzer_output.stdout.len().min(200)],
            );
            format!("Failed to parse java-analyzer output for {file_str}: {preview}")
        })?;

    Ok(analysis)
}

// ---------------------------------------------------------------------------
// Java daemon-mode analysis via ProcessPool (two pools)
// ---------------------------------------------------------------------------

/// Response from java-parser daemon.
/// Uses RawValue for `ast` to avoid parsing + re-serializing the full AST JSON.
#[derive(Deserialize)]
struct JavaParserResponse<'a> {
    status: String,
    #[serde(borrow)]
    ast: Option<&'a serde_json::value::RawValue>,
    error: Option<String>,
}

/// Analyze a single Java file via two persistent daemon process pools.
///
/// 1. Read source, send to java-parser pool → receive AST JSON
/// 2. Send AST to java-analyzer pool → receive FileAnalysis
pub async fn analyze_java_file_pooled(
    parser_pool: &ProcessPool,
    analyzer_pool: &ProcessPool,
    file: &Path,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Java source file {file_str}"))?;

    // Step 1: Send to java-parser pool
    let escaped_file = serde_json::to_string(&file_str)
        .with_context(|| format!("Failed to escape file path for {file_str}"))?;
    let escaped_source = serde_json::to_string(&source)
        .with_context(|| format!("Failed to escape source for {file_str}"))?;
    let parser_payload = format!(
        r#"{{"file":{},"source":{}}}"#,
        escaped_file, escaped_source
    );

    let parser_response_bytes = parser_pool
        .request(parser_payload.as_bytes())
        .await
        .with_context(|| format!("Java parser pool request failed for {file_str}"))?;

    // Zero-copy: parse only status/error, borrow raw AST JSON bytes
    let parser_response: JavaParserResponse =
        serde_json::from_slice(&parser_response_bytes)
            .with_context(|| format!("Failed to decode java-parser response for {file_str}"))?;

    let ast_raw = match parser_response.status.as_str() {
        "ok" => parser_response
            .ast
            .with_context(|| format!("java-parser returned ok but no ast for {file_str}"))?,
        "error" => {
            let msg = parser_response
                .error
                .unwrap_or_else(|| "unknown error".to_string());
            bail!("java-parser daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown java-parser response status '{other}' for {file_str}"),
    };

    // Step 2: Send to java-analyzer pool (raw AST bytes passed through without re-serialization)
    let analyzer_payload = format!(r#"{{"file":{},"ast":{}}}"#, escaped_file, ast_raw.get());

    let analyzer_response_bytes = analyzer_pool
        .request(analyzer_payload.as_bytes())
        .await
        .with_context(|| format!("Java analyzer pool request failed for {file_str}"))?;

    let response: DaemonResponse = serde_json::from_slice(&analyzer_response_bytes)
        .with_context(|| format!("Failed to decode java-analyzer response for {file_str}"))?;

    match response.status.as_str() {
        "ok" => response
            .result
            .with_context(|| format!("java-analyzer daemon returned ok but no result for {file_str}")),
        "error" => {
            let msg = response.error.unwrap_or_else(|| "unknown error".to_string());
            bail!("java-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown java-analyzer response status '{other}' for {file_str}"),
    }
}

// ---------------------------------------------------------------------------
// Java parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple Java files in parallel using two persistent daemon pools.
///
/// Creates a java-parser pool and a java-analyzer pool. For each file:
/// 1. Read source → send to java-parser pool → receive AST
/// 2. Send AST to java-analyzer pool → receive FileAnalysis
///
/// Falls back to `analyze_java_files_parallel` if pool creation fails.
pub async fn analyze_java_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Vec<AnalysisResult> {
    let parser_pool_config = PoolConfig {
        command: analyzers.java_parser_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let analyzer_pool_config = PoolConfig {
        command: analyzers.java_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let parser_pool = match ProcessPool::new(parser_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create java-parser pool, falling back to spawn-per-file: {e}"
            );
            return analyze_java_files_parallel(files, jobs, analyzers).await;
        }
    };

    let analyzer_pool = match ProcessPool::new(analyzer_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create java-analyzer pool, falling back to spawn-per-file: {e}"
            );
            parser_pool.shutdown().await;
            return analyze_java_files_parallel(files, jobs, analyzers).await;
        }
    };

    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let parser_pool = Arc::clone(&parser_pool);
            let analyzer_pool = Arc::clone(&analyzer_pool);
            let file = file.clone();
            let file_display = file.display().to_string();

            tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .expect("Semaphore closed unexpectedly");

                tracing::info!(
                    "[{}/{}] Analyzing Java file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_java_file_pooled(&parser_pool, &analyzer_pool, &file).await {
                    Ok(analysis) => AnalysisResult {
                        file,
                        analysis: Some(analysis),
                        errors,
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Java analyzer failed for {file_display}: {e}"
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
                    errors: vec![format!("Java analysis task failed: {e}")],
                });
            }
        }
    }

    parser_pool.shutdown().await;
    analyzer_pool.shutdown().await;
    results
}

/// Analyze multiple Java files in parallel with bounded concurrency (spawn mode).
///
/// Fallback when daemon pools cannot be created. Spawns separate processes per file.
pub async fn analyze_java_files_parallel(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Vec<AnalysisResult> {
    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();
    let analyzers = analyzers.clone();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let file = file.clone();
            let file_display = file.display().to_string();
            let analyzers = analyzers.clone();

            tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .expect("Semaphore closed unexpectedly");

                tracing::info!(
                    "[{}/{}] Analyzing Java file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_java_file(&file, &analyzers).await {
                    Ok(analysis) => AnalysisResult {
                        file,
                        analysis: Some(analysis),
                        errors,
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Java analyzer failed for {file_display}: {e}"
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
                    errors: vec![format!("Java analysis task failed: {e}")],
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Kotlin single-file analysis (two-stage: kotlin-parser → kotlin-analyzer)
// ---------------------------------------------------------------------------

/// Analyze a single Kotlin file: parse with kotlin-parser, then analyze with kotlin-analyzer.
///
/// Same two-stage pipeline as Java:
/// 1. Read source, send `{"file":"...","source":"..."}` to kotlin-parser
/// 2. Extract AST from parser response
/// 3. Send `{"file":"...","ast":{...}}` to kotlin-analyzer
/// 4. Return FileAnalysis
pub async fn analyze_kotlin_file(
    file: &Path,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Kotlin source file {file_str}"))?;

    // Step 1: Parse with kotlin-parser
    let parser_bin = analyzers.kotlin_parser_path();
    let mut parser_child = tokio::process::Command::new(&parser_bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn kotlin-parser for {file_str}"))?;

    let parser_payload = serde_json::json!({
        "file": file_str,
        "source": source,
    });

    {
        let stdin = parser_child
            .stdin
            .as_mut()
            .context("Failed to open stdin for kotlin-parser")?;
        stdin
            .write_all(parser_payload.to_string().as_bytes())
            .await
            .with_context(|| format!("Failed to write source to kotlin-parser stdin for {file_str}"))?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close kotlin-parser stdin for {file_str}"))?;
    }

    let parser_output = parser_child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for kotlin-parser for {file_str}"))?;

    if !parser_output.status.success() {
        let stderr = String::from_utf8_lossy(&parser_output.stderr);
        let code = parser_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("kotlin-parser exited with code {code} for {file_str}: {stderr}");
    }

    let parser_response: serde_json::Value =
        serde_json::from_slice(&parser_output.stdout).with_context(|| {
            let preview =
                String::from_utf8_lossy(&parser_output.stdout[..parser_output.stdout.len().min(200)]);
            format!("Failed to parse kotlin-parser output for {file_str}: {preview}")
        })?;

    if parser_response.get("status").and_then(|s| s.as_str()) != Some("ok") {
        let err = parser_response
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown error");
        bail!("kotlin-parser error for {file_str}: {err}");
    }

    let ast = parser_response
        .get("ast")
        .with_context(|| format!("kotlin-parser returned ok but no ast for {file_str}"))?;

    // Step 2: Analyze with kotlin-analyzer
    let analyzer_bin = analyzers.kotlin_path();
    let mut analyzer_child = tokio::process::Command::new(&analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn kotlin-analyzer for {file_str}"))?;

    let analyzer_payload = serde_json::json!({
        "file": file_str,
        "ast": ast,
    });

    {
        let stdin = analyzer_child
            .stdin
            .as_mut()
            .context("Failed to open stdin for kotlin-analyzer")?;
        stdin
            .write_all(analyzer_payload.to_string().as_bytes())
            .await
            .with_context(|| {
                format!("Failed to write AST to kotlin-analyzer stdin for {file_str}")
            })?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close kotlin-analyzer stdin for {file_str}"))?;
    }

    let analyzer_output = analyzer_child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for kotlin-analyzer for {file_str}"))?;

    if !analyzer_output.status.success() {
        let stderr = String::from_utf8_lossy(&analyzer_output.stderr);
        let code = analyzer_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("kotlin-analyzer exited with code {code} for {file_str}: {stderr}");
    }

    let analysis: FileAnalysis =
        serde_json::from_slice(&analyzer_output.stdout).with_context(|| {
            let preview = String::from_utf8_lossy(
                &analyzer_output.stdout[..analyzer_output.stdout.len().min(200)],
            );
            format!("Failed to parse kotlin-analyzer output for {file_str}: {preview}")
        })?;

    Ok(analysis)
}

// ---------------------------------------------------------------------------
// Kotlin daemon-mode analysis via ProcessPool (two pools)
// ---------------------------------------------------------------------------

/// Analyze a single Kotlin file via two persistent daemon process pools.
///
/// 1. Read source, send to kotlin-parser pool → receive AST JSON
/// 2. Send AST to kotlin-analyzer pool → receive FileAnalysis
pub async fn analyze_kotlin_file_pooled(
    parser_pool: &ProcessPool,
    analyzer_pool: &ProcessPool,
    file: &Path,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Kotlin source file {file_str}"))?;

    // Step 1: Send to kotlin-parser pool
    let escaped_file = serde_json::to_string(&file_str)
        .with_context(|| format!("Failed to escape file path for {file_str}"))?;
    let escaped_source = serde_json::to_string(&source)
        .with_context(|| format!("Failed to escape source for {file_str}"))?;
    let parser_payload = format!(
        r#"{{"file":{},"source":{}}}"#,
        escaped_file, escaped_source
    );

    let parser_response_bytes = parser_pool
        .request(parser_payload.as_bytes())
        .await
        .with_context(|| format!("Kotlin parser pool request failed for {file_str}"))?;

    // Zero-copy: parse only status/error, borrow raw AST JSON bytes
    let parser_response: JavaParserResponse =
        serde_json::from_slice(&parser_response_bytes)
            .with_context(|| format!("Failed to decode kotlin-parser response for {file_str}"))?;

    let ast_raw = match parser_response.status.as_str() {
        "ok" => parser_response
            .ast
            .with_context(|| format!("kotlin-parser returned ok but no ast for {file_str}"))?,
        "error" => {
            let msg = parser_response
                .error
                .unwrap_or_else(|| "unknown error".to_string());
            bail!("kotlin-parser daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown kotlin-parser response status '{other}' for {file_str}"),
    };

    // Step 2: Send to kotlin-analyzer pool
    let analyzer_payload = format!(r#"{{"file":{},"ast":{}}}"#, escaped_file, ast_raw.get());

    let analyzer_response_bytes = analyzer_pool
        .request(analyzer_payload.as_bytes())
        .await
        .with_context(|| format!("Kotlin analyzer pool request failed for {file_str}"))?;

    let response: DaemonResponse = serde_json::from_slice(&analyzer_response_bytes)
        .with_context(|| format!("Failed to decode kotlin-analyzer response for {file_str}"))?;

    match response.status.as_str() {
        "ok" => response
            .result
            .with_context(|| format!("kotlin-analyzer daemon returned ok but no result for {file_str}")),
        "error" => {
            let msg = response.error.unwrap_or_else(|| "unknown error".to_string());
            bail!("kotlin-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown kotlin-analyzer response status '{other}' for {file_str}"),
    }
}

// ---------------------------------------------------------------------------
// Kotlin parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple Kotlin files in parallel using two persistent daemon pools.
///
/// Falls back to `analyze_kotlin_files_parallel` if pool creation fails.
pub async fn analyze_kotlin_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Vec<AnalysisResult> {
    let parser_pool_config = PoolConfig {
        command: analyzers.kotlin_parser_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let analyzer_pool_config = PoolConfig {
        command: analyzers.kotlin_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let parser_pool = match ProcessPool::new(parser_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create kotlin-parser pool, falling back to spawn-per-file: {e}"
            );
            return analyze_kotlin_files_parallel(files, jobs, analyzers).await;
        }
    };

    let analyzer_pool = match ProcessPool::new(analyzer_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create kotlin-analyzer pool, falling back to spawn-per-file: {e}"
            );
            parser_pool.shutdown().await;
            return analyze_kotlin_files_parallel(files, jobs, analyzers).await;
        }
    };

    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let parser_pool = Arc::clone(&parser_pool);
            let analyzer_pool = Arc::clone(&analyzer_pool);
            let file = file.clone();
            let file_display = file.display().to_string();

            tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .expect("Semaphore closed unexpectedly");

                tracing::info!(
                    "[{}/{}] Analyzing Kotlin file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_kotlin_file_pooled(&parser_pool, &analyzer_pool, &file).await {
                    Ok(analysis) => AnalysisResult {
                        file,
                        analysis: Some(analysis),
                        errors,
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Kotlin analyzer failed for {file_display}: {e}"
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
                    errors: vec![format!("Kotlin analysis task failed: {e}")],
                });
            }
        }
    }

    parser_pool.shutdown().await;
    analyzer_pool.shutdown().await;
    results
}

/// Analyze multiple Kotlin files in parallel with bounded concurrency (spawn mode).
///
/// Fallback when daemon pools cannot be created.
pub async fn analyze_kotlin_files_parallel(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Vec<AnalysisResult> {
    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();
    let analyzers = analyzers.clone();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let file = file.clone();
            let file_display = file.display().to_string();
            let analyzers = analyzers.clone();

            tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .expect("Semaphore closed unexpectedly");

                tracing::info!(
                    "[{}/{}] Analyzing Kotlin file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_kotlin_file(&file, &analyzers).await {
                    Ok(analysis) => AnalysisResult {
                        file,
                        analysis: Some(analysis),
                        errors,
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Kotlin analyzer failed for {file_display}: {e}"
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
                    errors: vec![format!("Kotlin analysis task failed: {e}")],
                });
            }
        }
    }

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
            // Merge line/column/endLine/endColumn into metadata so RFDB stores position info
            let mut meta = node.metadata.clone();
            // Merge extra top-level fields (e.g. "source", "specifiers") into metadata
            for (k, v) in &node.extra {
                meta.entry(k.clone()).or_insert_with(|| v.clone());
            }
            meta.insert("line".to_string(), serde_json::json!(node.line));
            meta.insert("column".to_string(), serde_json::json!(node.column));
            meta.insert("endLine".to_string(), serde_json::json!(node.end_line));
            meta.insert("endColumn".to_string(), serde_json::json!(node.end_column));

            let metadata = Some(serde_json::to_string(&meta).unwrap());

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
    // JS/TS types
    "IMPORT_BINDING",
    "IMPORT",
    "EXPORT_BINDING",
    "EXPORT",
    "FUNCTION",
    "VARIABLE",
    "CONSTANT",
    "CLASS",
    "CALL",
    "METHOD",
    "REFERENCE",
    "PROPERTY_ACCESS",
    "PROPERTY_ASSIGNMENT",
    // Haskell types
    "TYPE_CLASS",
    "INSTANCE",
    "DATA_TYPE",
    "CONSTRUCTOR",
    "TYPE_SYNONYM",
    "TYPE_FAMILY",
    "RECORD_FIELD",
    // Rust types
    "STRUCT",
    "ENUM",
    "VARIANT",
    "TRAIT",
    "IMPL_BLOCK",
    "MODULE",
    // Java types
    "INTERFACE",
    "RECORD",
    "PARAMETER",
    "ATTRIBUTE",
    "CLOSURE",
    "TYPE_PARAMETER",
    // Python types
    "UNSAFE_DYNAMIC",
    // Control flow (shared across languages)
    "LOOP",
    "BRANCH",
    "TRY_BLOCK",
    "CATCH_BLOCK",
    "FINALLY_BLOCK",
    "CASE",
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

/// Like `collect_resolve_nodes`, but only includes nodes from files matching
/// the given language. Prevents cross-language contamination where a Haskell
/// resolver would see JS MODULE nodes (or vice versa).
pub fn collect_resolve_nodes_for_lang(
    results: &[AnalysisResult],
    lang: crate::config::Language,
) -> Vec<serde_json::Value> {
    results
        .iter()
        .filter_map(|r| r.analysis.as_ref())
        .filter(|a| {
            crate::config::detect_language(std::path::Path::new(&a.file)) == Some(lang)
        })
        .flat_map(|a| &a.nodes)
        .filter(|n| RESOLVE_NODE_TYPES.contains(&n.node_type.as_str()))
        .filter_map(|n| serde_json::to_value(n).ok())
        .collect()
}

/// Like `collect_resolve_nodes_for_lang`, but collects nodes from ALL JVM
/// languages (Java + Kotlin). Used by jvm-cross-resolve which needs nodes
/// from both languages to resolve cross-language edges.
pub fn collect_resolve_nodes_for_jvm(
    results: &[AnalysisResult],
) -> Vec<serde_json::Value> {
    results
        .iter()
        .filter_map(|r| r.analysis.as_ref())
        .filter(|a| {
            matches!(
                crate::config::detect_language(std::path::Path::new(&a.file)),
                Some(crate::config::Language::Java) | Some(crate::config::Language::Kotlin)
            )
        })
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
    analyzer_bin: &str,
) -> Vec<AnalysisResult> {
    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();
    let analyzer_bin = analyzer_bin.to_string();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let file = file.clone();
            let file_display = file.display().to_string();
            let bin = analyzer_bin.clone();

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
                match analyze_file(&file, &ast_json, &bin).await {
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
// Python single-file analysis (spawn mode)
// ---------------------------------------------------------------------------

/// Analyze a single Python file: parse with rustpython-parser, send AST to python-analyzer daemon.
pub async fn analyze_python_file(file: &Path, ast_json: &str, analyzer_bin: &str) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let mut child = tokio::process::Command::new(analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn grafema-python-analyzer for {file_str}"))?;

    let payload = serde_json::json!({
        "file": file_str,
        "ast": serde_json::from_str::<serde_json::Value>(ast_json)
            .unwrap_or(serde_json::Value::Null),
    });

    {
        let stdin = child.stdin.as_mut()
            .context("Failed to open stdin for grafema-python-analyzer")?;
        stdin.write_all(payload.to_string().as_bytes()).await
            .with_context(|| format!("Failed to write AST to grafema-python-analyzer stdin for {file_str}"))?;
        stdin.shutdown().await
            .with_context(|| format!("Failed to close grafema-python-analyzer stdin for {file_str}"))?;
    }

    let output = child.wait_with_output().await
        .with_context(|| format!("Failed to wait for grafema-python-analyzer for {file_str}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        anyhow::bail!("grafema-python-analyzer exited with code {code} for {file_str}: {stderr}");
    }

    let stdout = &output.stdout;
    let analysis: FileAnalysis = serde_json::from_slice(stdout).with_context(|| {
        let preview = String::from_utf8_lossy(&stdout[..stdout.len().min(200)]);
        format!("Failed to parse grafema-python-analyzer output for {file_str}: {preview}")
    })?;

    Ok(analysis)
}

// ---------------------------------------------------------------------------
// Python daemon-mode analysis via ProcessPool
// ---------------------------------------------------------------------------

/// Analyze a single Python file via a persistent daemon process pool.
pub async fn analyze_python_file_pooled(
    pool: &ProcessPool,
    file: &Path,
    ast_json: &str,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

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
            bail!("grafema-python-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown daemon response status '{other}' for {file_str}"),
    }
}

// ---------------------------------------------------------------------------
// Python parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple Python files in parallel using persistent daemon processes.
pub async fn analyze_python_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Vec<AnalysisResult> {
    let pool_config = PoolConfig {
        command: analyzers.python_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let pool = match ProcessPool::new(pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create grafema-python-analyzer pool, falling back to spawn-per-file: {e}"
            );
            return analyze_python_files_parallel(files, jobs, &analyzers.python_path()).await;
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
                let _permit = sem.acquire().await.expect("Semaphore closed unexpectedly");
                tracing::info!("[{}/{}] Analyzing Python file {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Step 1: Parse with rustpython-parser (CPU-bound -> spawn_blocking)
                let parse_result = {
                    let file_clone = file.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::python_parser::parse_python_file(&file_clone)
                    }).await
                };

                let ast_json = match parse_result {
                    Ok(Ok(json)) => json,
                    Ok(Err(e)) => {
                        errors.push(format!("Python parse failed for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors };
                    }
                    Err(e) => {
                        errors.push(format!("Python parse task panicked for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors };
                    }
                };

                // Step 2: Send to daemon pool
                match analyze_python_file_pooled(&pool, &file, &ast_json).await {
                    Ok(analysis) => AnalysisResult { file, analysis: Some(analysis), errors },
                    Err(e) => {
                        errors.push(format!("Python analyzer failed for {file_display}: {e}"));
                        AnalysisResult { file, analysis: None, errors }
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
                    errors: vec![format!("Python analysis task failed: {e}")],
                });
            }
        }
    }

    pool.shutdown().await;
    results
}

/// Fallback: analyze Python files in parallel by spawning per-file processes.
pub async fn analyze_python_files_parallel(
    files: &[PathBuf],
    jobs: usize,
    analyzer_bin: &str,
) -> Vec<AnalysisResult> {
    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();
    let analyzer_bin = analyzer_bin.to_string();

    let handles: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(idx, file)| {
            let sem = Arc::clone(&semaphore);
            let file = file.clone();
            let file_display = file.display().to_string();
            let bin = analyzer_bin.clone();

            tokio::spawn(async move {
                let _permit = sem.acquire().await.expect("Semaphore closed unexpectedly");
                tracing::info!("[{}/{}] Analyzing Python file {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Step 1: Parse with rustpython-parser
                let ast_json = match crate::python_parser::parse_python_file(&file) {
                    Ok(json) => json,
                    Err(e) => {
                        errors.push(format!("Python parse failed for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors };
                    }
                };

                // Step 2: Spawn analyzer
                match analyze_python_file(&file, &ast_json, &bin).await {
                    Ok(analysis) => AnalysisResult { file, analysis: Some(analysis), errors },
                    Err(e) => {
                        errors.push(format!("Python analyzer failed for {file_display}: {e}"));
                        AnalysisResult { file, analysis: None, errors }
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
                    errors: vec![format!("Python analysis task failed: {e}")],
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
                    end_line: 0,
                    end_column: 0,
                    exported: true,
                    metadata: {
                        let mut m = HashMap::new();
                        m.insert("async".to_string(), serde_json::Value::Bool(true));
                        m
                    },
                    extra: HashMap::new(),
                },
                GraphNode {
                    id: "src/foo.js->VARIABLE->x".to_string(),
                    node_type: "VARIABLE".to_string(),
                    name: "x".to_string(),
                    file: "src/foo.js".to_string(),
                    line: 1,
                    column: 6,
                    end_line: 0,
                    end_column: 0,
                    exported: false,
                    metadata: HashMap::new(),
                    extra: HashMap::new(),
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

        // Second node: non-exported variable — no user metadata, but line/col injected
        let n1 = &wire[1];
        assert_eq!(n1.id, "src/foo.js->VARIABLE->x");
        assert!(!n1.exported);
        assert!(n1.metadata.is_some());
        let meta1: serde_json::Value =
            serde_json::from_str(n1.metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta1["line"], 1);
        assert_eq!(meta1["column"], 6);
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
    fn relativize_paths_strips_root_prefix() {
        let mut analysis = FileAnalysis {
            file: "/home/user/project/src/app.ts".to_string(),
            module_id: "MODULE#/home/user/project/src/app.ts".to_string(),
            nodes: vec![GraphNode {
                id: "/home/user/project/src/app.ts->FUNCTION->main".to_string(),
                node_type: "FUNCTION".to_string(),
                name: "main".to_string(),
                file: "/home/user/project/src/app.ts".to_string(),
                line: 1,
                column: 0,
                end_line: 10,
                end_column: 1,
                exported: true,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            }],
            edges: vec![GraphEdge {
                src: "/home/user/project/src/app.ts->FUNCTION->main".to_string(),
                dst: "/home/user/project/src/utils.ts->FUNCTION->helper".to_string(),
                edge_type: "CALLS".to_string(),
                metadata: HashMap::new(),
            }],
            exports: vec![ExportInfo {
                name: "main".to_string(),
                node_id: "/home/user/project/src/app.ts->FUNCTION->main".to_string(),
                kind: "named".to_string(),
                source: None,
            }],
        };

        analysis.relativize_paths("/home/user/project");

        assert_eq!(analysis.file, "src/app.ts");
        assert_eq!(analysis.module_id, "MODULE#src/app.ts");
        assert_eq!(analysis.nodes[0].id, "src/app.ts->FUNCTION->main");
        assert_eq!(analysis.nodes[0].file, "src/app.ts");
        assert_eq!(analysis.edges[0].src, "src/app.ts->FUNCTION->main");
        assert_eq!(analysis.edges[0].dst, "src/utils.ts->FUNCTION->helper");
        assert_eq!(analysis.exports[0].node_id, "src/app.ts->FUNCTION->main");
    }

    #[test]
    fn relativize_paths_strips_hash_prefixed_ids() {
        let mut analysis = FileAnalysis {
            file: "/home/user/project/src/app.ts".to_string(),
            module_id: "/home/user/project/src/app.ts".to_string(),
            nodes: vec![GraphNode {
                id: "MODULE#/home/user/project/src/app.ts".to_string(),
                node_type: "MODULE".to_string(),
                name: "/home/user/project/src/app.ts".to_string(),
                file: "/home/user/project/src/app.ts".to_string(),
                line: 1,
                column: 0,
                end_line: 1,
                end_column: 0,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            }],
            edges: vec![GraphEdge {
                src: "MODULE#/home/user/project/src/app.ts".to_string(),
                dst: "/home/user/project/src/app.ts->FUNCTION->main".to_string(),
                edge_type: "CONTAINS".to_string(),
                metadata: HashMap::new(),
            }],
            exports: vec![],
        };

        analysis.relativize_paths("/home/user/project");

        assert_eq!(analysis.nodes[0].id, "MODULE#src/app.ts");
        assert_eq!(analysis.nodes[0].file, "src/app.ts");
        assert_eq!(analysis.edges[0].src, "MODULE#src/app.ts");
        assert_eq!(analysis.edges[0].dst, "src/app.ts->FUNCTION->main");
    }

    #[test]
    fn relativize_paths_noop_for_already_relative() {
        let mut analysis = FileAnalysis {
            file: "src/app.ts".to_string(),
            module_id: "src/app.ts".to_string(),
            nodes: vec![],
            edges: vec![],
            exports: vec![],
        };

        analysis.relativize_paths("/home/user/project");

        assert_eq!(analysis.file, "src/app.ts");
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
                        end_line: 0,
                        end_column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "test.js->FUNCTION->bar".to_string(),
                        node_type: "FUNCTION".to_string(),
                        name: "bar".to_string(),
                        file: "test.js".to_string(),
                        line: 5,
                        column: 0,
                        end_line: 0,
                        end_column: 0,
                        exported: true,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "test.js->REFERENCE->baz".to_string(),
                        node_type: "REFERENCE".to_string(),
                        name: "baz".to_string(),
                        file: "test.js".to_string(),
                        line: 10,
                        column: 0,
                        end_line: 0,
                        end_column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "test.js->CALL->qux".to_string(),
                        node_type: "CALL".to_string(),
                        name: "qux".to_string(),
                        file: "test.js".to_string(),
                        line: 12,
                        column: 0,
                        end_line: 0,
                        end_column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                ],
                edges: vec![],
                exports: vec![],
            }),
            errors: vec![],
        }];

        let nodes = collect_resolve_nodes(&results);
        // Should include IMPORT_BINDING, FUNCTION, REFERENCE, and CALL
        assert_eq!(nodes.len(), 4);
        assert_eq!(nodes[0]["type"], "IMPORT_BINDING");
        assert_eq!(nodes[1]["type"], "FUNCTION");
        assert_eq!(nodes[2]["type"], "REFERENCE");
        assert_eq!(nodes[3]["type"], "CALL");
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
                        end_line: 0,
                        end_column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
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
    fn haskell_daemon_request_json_concatenation() {
        let file_str = "src/Main.hs";
        let source = "module Main where\n\nmain :: IO ()\nmain = putStrLn \"hello\"";

        let escaped_file = serde_json::to_string(file_str).unwrap();
        let escaped_source = serde_json::to_string(source).unwrap();
        let payload = format!(
            r#"{{"file":{},"source":{}}}"#,
            escaped_file, escaped_source
        );

        let decoded: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(decoded["file"], "src/Main.hs");
        assert_eq!(
            decoded["source"],
            "module Main where\n\nmain :: IO ()\nmain = putStrLn \"hello\""
        );
        // Must NOT have an "ast" field — Haskell uses "source" instead
        assert!(decoded.get("ast").is_none());
    }

    #[test]
    fn haskell_daemon_request_escapes_special_chars() {
        let file_str = "src/Some\"Path.hs";
        let source = "line1\nline2\ttab\\backslash";

        let escaped_file = serde_json::to_string(file_str).unwrap();
        let escaped_source = serde_json::to_string(source).unwrap();
        let payload = format!(
            r#"{{"file":{},"source":{}}}"#,
            escaped_file, escaped_source
        );

        let decoded: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(decoded["file"], "src/Some\"Path.hs");
        assert_eq!(decoded["source"], "line1\nline2\ttab\\backslash");
    }

    #[test]
    fn resolve_node_types_include_haskell_types() {
        let haskell_types = [
            "TYPE_CLASS",
            "INSTANCE",
            "DATA_TYPE",
            "CONSTRUCTOR",
            "TYPE_SYNONYM",
            "TYPE_FAMILY",
        ];
        for hs_type in &haskell_types {
            assert!(
                RESOLVE_NODE_TYPES.contains(hs_type),
                "RESOLVE_NODE_TYPES should contain {hs_type}"
            );
        }
    }

    #[test]
    fn collect_resolve_nodes_includes_haskell_types() {
        let results = vec![AnalysisResult {
            file: PathBuf::from("src/Types.hs"),
            analysis: Some(FileAnalysis {
                file: "src/Types.hs".to_string(),
                module_id: "src/Types.hs".to_string(),
                nodes: vec![
                    GraphNode {
                        id: "src/Types.hs->TYPE_CLASS->Monad".to_string(),
                        node_type: "TYPE_CLASS".to_string(),
                        name: "Monad".to_string(),
                        file: "src/Types.hs".to_string(),
                        line: 1,
                        column: 0,
                        end_line: 0,
                        end_column: 0,
                        exported: true,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "src/Types.hs->DATA_TYPE->Maybe".to_string(),
                        node_type: "DATA_TYPE".to_string(),
                        name: "Maybe".to_string(),
                        file: "src/Types.hs".to_string(),
                        line: 5,
                        column: 0,
                        end_line: 0,
                        end_column: 0,
                        exported: true,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "src/Types.hs->CONSTRUCTOR->Just".to_string(),
                        node_type: "CONSTRUCTOR".to_string(),
                        name: "Just".to_string(),
                        file: "src/Types.hs".to_string(),
                        line: 5,
                        column: 20,
                        end_line: 0,
                        end_column: 0,
                        exported: true,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "src/Types.hs->INSTANCE->Monad_Maybe".to_string(),
                        node_type: "INSTANCE".to_string(),
                        name: "Monad Maybe".to_string(),
                        file: "src/Types.hs".to_string(),
                        line: 10,
                        column: 0,
                        end_line: 0,
                        end_column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "src/Types.hs->TYPE_SYNONYM->String".to_string(),
                        node_type: "TYPE_SYNONYM".to_string(),
                        name: "String".to_string(),
                        file: "src/Types.hs".to_string(),
                        line: 15,
                        column: 0,
                        end_line: 0,
                        end_column: 0,
                        exported: true,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "src/Types.hs->TYPE_FAMILY->Element".to_string(),
                        node_type: "TYPE_FAMILY".to_string(),
                        name: "Element".to_string(),
                        file: "src/Types.hs".to_string(),
                        line: 20,
                        column: 0,
                        end_line: 0,
                        end_column: 0,
                        exported: true,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "src/Types.hs->EXPRESSION->expr1".to_string(),
                        node_type: "EXPRESSION".to_string(),
                        name: "expr1".to_string(),
                        file: "src/Types.hs".to_string(),
                        line: 25,
                        column: 0,
                        end_line: 0,
                        end_column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                ],
                edges: vec![],
                exports: vec![],
            }),
            errors: vec![],
        }];

        let nodes = collect_resolve_nodes(&results);
        // Should include all 6 Haskell types, skip EXPRESSION
        assert_eq!(nodes.len(), 6);
        let types: Vec<&str> = nodes
            .iter()
            .map(|n| n["type"].as_str().unwrap())
            .collect();
        assert!(types.contains(&"TYPE_CLASS"));
        assert!(types.contains(&"DATA_TYPE"));
        assert!(types.contains(&"CONSTRUCTOR"));
        assert!(types.contains(&"INSTANCE"));
        assert!(types.contains(&"TYPE_SYNONYM"));
        assert!(types.contains(&"TYPE_FAMILY"));
        assert!(!types.contains(&"EXPRESSION"));
    }

    #[test]
    fn collect_resolve_nodes_for_lang_filters_by_language() {
        let results = vec![
            AnalysisResult {
                file: PathBuf::from("src/index.ts"),
                analysis: Some(FileAnalysis {
                    file: "src/index.ts".to_string(),
                    module_id: "src/index.ts".to_string(),
                    nodes: vec![
                        GraphNode {
                            id: "src/index.ts->MODULE->index".to_string(),
                            node_type: "MODULE".to_string(),
                            name: "index".to_string(),
                            file: "src/index.ts".to_string(),
                            line: 1, column: 0, end_line: 50, end_column: 0,
                            exported: false,
                            metadata: HashMap::new(),
                            extra: HashMap::new(),
                        },
                        GraphNode {
                            id: "src/index.ts->FUNCTION->main".to_string(),
                            node_type: "FUNCTION".to_string(),
                            name: "main".to_string(),
                            file: "src/index.ts".to_string(),
                            line: 5, column: 0, end_line: 10, end_column: 1,
                            exported: true,
                            metadata: HashMap::new(),
                            extra: HashMap::new(),
                        },
                    ],
                    edges: vec![],
                    exports: vec![],
                }),
                errors: vec![],
            },
            AnalysisResult {
                file: PathBuf::from("src/Main.hs"),
                analysis: Some(FileAnalysis {
                    file: "src/Main.hs".to_string(),
                    module_id: "src/Main.hs".to_string(),
                    nodes: vec![
                        GraphNode {
                            id: "src/Main.hs->MODULE->Main".to_string(),
                            node_type: "MODULE".to_string(),
                            name: "Main".to_string(),
                            file: "src/Main.hs".to_string(),
                            line: 1, column: 0, end_line: 30, end_column: 0,
                            exported: false,
                            metadata: HashMap::new(),
                            extra: HashMap::new(),
                        },
                        GraphNode {
                            id: "src/Main.hs->DATA_TYPE->Config".to_string(),
                            node_type: "DATA_TYPE".to_string(),
                            name: "Config".to_string(),
                            file: "src/Main.hs".to_string(),
                            line: 10, column: 0, end_line: 15, end_column: 0,
                            exported: true,
                            metadata: HashMap::new(),
                            extra: HashMap::new(),
                        },
                    ],
                    edges: vec![],
                    exports: vec![],
                }),
                errors: vec![],
            },
        ];

        // JS filter: only src/index.ts nodes
        let js_nodes = collect_resolve_nodes_for_lang(
            &results, crate::config::Language::JavaScript,
        );
        assert_eq!(js_nodes.len(), 2);
        assert!(js_nodes.iter().all(|n| n["file"].as_str().unwrap().ends_with(".ts")));

        // Haskell filter: only src/Main.hs nodes
        let hs_nodes = collect_resolve_nodes_for_lang(
            &results, crate::config::Language::Haskell,
        );
        assert_eq!(hs_nodes.len(), 2);
        assert!(hs_nodes.iter().all(|n| n["file"].as_str().unwrap().ends_with(".hs")));

        // Rust filter: no Rust files → empty
        let rs_nodes = collect_resolve_nodes_for_lang(
            &results, crate::config::Language::Rust,
        );
        assert!(rs_nodes.is_empty());
    }

    #[test]
    fn collect_resolve_nodes_for_lang_empty_results() {
        let nodes = collect_resolve_nodes_for_lang(
            &[], crate::config::Language::JavaScript,
        );
        assert!(nodes.is_empty());
    }

    #[test]
    fn collect_resolve_nodes_for_lang_skips_non_resolve_types() {
        let results = vec![AnalysisResult {
            file: PathBuf::from("src/app.ts"),
            analysis: Some(FileAnalysis {
                file: "src/app.ts".to_string(),
                module_id: "src/app.ts".to_string(),
                nodes: vec![
                    GraphNode {
                        id: "src/app.ts->FUNCTION->foo".to_string(),
                        node_type: "FUNCTION".to_string(),
                        name: "foo".to_string(),
                        file: "src/app.ts".to_string(),
                        line: 1, column: 0, end_line: 5, end_column: 1,
                        exported: false,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                    GraphNode {
                        id: "src/app.ts->EXPRESSION->bar".to_string(),
                        node_type: "EXPRESSION".to_string(),
                        name: "bar".to_string(),
                        file: "src/app.ts".to_string(),
                        line: 3, column: 0, end_line: 3, end_column: 10,
                        exported: false,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                ],
                edges: vec![],
                exports: vec![],
            }),
            errors: vec![],
        }];

        let nodes = collect_resolve_nodes_for_lang(
            &results, crate::config::Language::JavaScript,
        );
        // FUNCTION is in RESOLVE_NODE_TYPES, EXPRESSION is not
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["type"].as_str().unwrap(), "FUNCTION");
    }

    #[test]
    fn collect_resolve_nodes_for_jvm_combines_java_and_kotlin() {
        let results = vec![
            AnalysisResult {
                file: PathBuf::from("src/Foo.java"),
                analysis: Some(FileAnalysis {
                    file: "src/Foo.java".to_string(),
                    module_id: "src/Foo.java".to_string(),
                    nodes: vec![
                        GraphNode {
                            id: "src/Foo.java->MODULE->Foo".to_string(),
                            node_type: "MODULE".to_string(),
                            name: "Foo".to_string(),
                            file: "src/Foo.java".to_string(),
                            line: 1, column: 0, end_line: 50, end_column: 0,
                            exported: false,
                            metadata: HashMap::new(),
                            extra: HashMap::new(),
                        },
                        GraphNode {
                            id: "src/Foo.java->CLASS->Foo".to_string(),
                            node_type: "CLASS".to_string(),
                            name: "Foo".to_string(),
                            file: "src/Foo.java".to_string(),
                            line: 3, column: 0, end_line: 50, end_column: 0,
                            exported: true,
                            metadata: HashMap::new(),
                            extra: HashMap::new(),
                        },
                    ],
                    edges: vec![],
                    exports: vec![],
                }),
                errors: vec![],
            },
            AnalysisResult {
                file: PathBuf::from("src/Bar.kt"),
                analysis: Some(FileAnalysis {
                    file: "src/Bar.kt".to_string(),
                    module_id: "src/Bar.kt".to_string(),
                    nodes: vec![
                        GraphNode {
                            id: "src/Bar.kt->MODULE->Bar".to_string(),
                            node_type: "MODULE".to_string(),
                            name: "Bar".to_string(),
                            file: "src/Bar.kt".to_string(),
                            line: 1, column: 0, end_line: 30, end_column: 0,
                            exported: false,
                            metadata: HashMap::new(),
                            extra: HashMap::new(),
                        },
                        GraphNode {
                            id: "src/Bar.kt->IMPORT->com.example.Foo".to_string(),
                            node_type: "IMPORT".to_string(),
                            name: "com.example.Foo".to_string(),
                            file: "src/Bar.kt".to_string(),
                            line: 2, column: 0, end_line: 2, end_column: 30,
                            exported: false,
                            metadata: HashMap::new(),
                            extra: HashMap::new(),
                        },
                    ],
                    edges: vec![],
                    exports: vec![],
                }),
                errors: vec![],
            },
            // JS file should be excluded
            AnalysisResult {
                file: PathBuf::from("src/index.ts"),
                analysis: Some(FileAnalysis {
                    file: "src/index.ts".to_string(),
                    module_id: "src/index.ts".to_string(),
                    nodes: vec![
                        GraphNode {
                            id: "src/index.ts->MODULE->index".to_string(),
                            node_type: "MODULE".to_string(),
                            name: "index".to_string(),
                            file: "src/index.ts".to_string(),
                            line: 1, column: 0, end_line: 10, end_column: 0,
                            exported: false,
                            metadata: HashMap::new(),
                            extra: HashMap::new(),
                        },
                    ],
                    edges: vec![],
                    exports: vec![],
                }),
                errors: vec![],
            },
        ];

        let jvm_nodes = collect_resolve_nodes_for_jvm(&results);
        // Should include Java (MODULE + CLASS) and Kotlin (MODULE + IMPORT) nodes, but NOT JS
        assert_eq!(jvm_nodes.len(), 4);
        let files: Vec<&str> = jvm_nodes.iter().map(|n| n["file"].as_str().unwrap()).collect();
        assert!(files.iter().all(|f| f.ends_with(".java") || f.ends_with(".kt")));
        assert!(!files.iter().any(|f| f.ends_with(".ts")));
    }

    #[test]
    fn collect_resolve_nodes_for_jvm_empty_results() {
        let nodes = collect_resolve_nodes_for_jvm(&[]);
        assert!(nodes.is_empty());
    }

    #[test]
    fn collect_resolve_nodes_for_jvm_no_jvm_files() {
        let results = vec![AnalysisResult {
            file: PathBuf::from("src/index.ts"),
            analysis: Some(FileAnalysis {
                file: "src/index.ts".to_string(),
                module_id: "src/index.ts".to_string(),
                nodes: vec![
                    GraphNode {
                        id: "src/index.ts->MODULE->index".to_string(),
                        node_type: "MODULE".to_string(),
                        name: "index".to_string(),
                        file: "src/index.ts".to_string(),
                        line: 1, column: 0, end_line: 10, end_column: 0,
                        exported: false,
                        metadata: HashMap::new(),
                        extra: HashMap::new(),
                    },
                ],
                edges: vec![],
                exports: vec![],
            }),
            errors: vec![],
        }];
        let nodes = collect_resolve_nodes_for_jvm(&results);
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
            end_line: 10,
            end_column: 1,
            exported: false,
            metadata: HashMap::new(),
            extra: HashMap::new(),
        };
        let value = serde_json::to_value(&node).unwrap();
        // Should serialize node_type as "type" due to #[serde(rename = "type")]
        assert_eq!(value["type"], "FUNCTION");
        assert!(value.get("node_type").is_none());
    }

    #[test]
    fn ensure_function_contains_adds_missing_edges() {
        let mut analysis = FileAnalysis {
            file: "src/app.js".to_string(),
            module_id: "MODULE#src/app.js".to_string(),
            nodes: vec![
                GraphNode {
                    id: "FUNCTION#src/app.js:declared".to_string(),
                    node_type: "FUNCTION".to_string(),
                    name: "declared".to_string(),
                    file: "src/app.js".to_string(),
                    line: 1, column: 0, end_line: 5, end_column: 1,
                    exported: false,
                    metadata: HashMap::new(),
                    extra: HashMap::new(),
                },
                GraphNode {
                    id: "FUNCTION#src/app.js:arrow".to_string(),
                    node_type: "FUNCTION".to_string(),
                    name: "arrow".to_string(),
                    file: "src/app.js".to_string(),
                    line: 7, column: 0, end_line: 9, end_column: 1,
                    exported: false,
                    metadata: HashMap::new(),
                    extra: HashMap::new(),
                },
                GraphNode {
                    id: "VARIABLE#src/app.js:x".to_string(),
                    node_type: "VARIABLE".to_string(),
                    name: "x".to_string(),
                    file: "src/app.js".to_string(),
                    line: 11, column: 0, end_line: 11, end_column: 10,
                    exported: false,
                    metadata: HashMap::new(),
                    extra: HashMap::new(),
                },
            ],
            edges: vec![
                // Only "declared" has CONTAINS already
                GraphEdge {
                    src: "MODULE#src/app.js".to_string(),
                    dst: "FUNCTION#src/app.js:declared".to_string(),
                    edge_type: "CONTAINS".to_string(),
                    metadata: HashMap::new(),
                },
            ],
            exports: vec![],
        };

        analysis.ensure_function_contains_edges();

        // Should have added CONTAINS for "arrow" but not duplicate for "declared"
        let contains_edges: Vec<_> = analysis.edges.iter()
            .filter(|e| e.edge_type == "CONTAINS")
            .collect();
        assert_eq!(contains_edges.len(), 2);

        // Verify the new edge
        let arrow_contains = contains_edges.iter()
            .find(|e| e.dst == "FUNCTION#src/app.js:arrow")
            .expect("arrow should have CONTAINS edge");
        assert_eq!(arrow_contains.src, "MODULE#src/app.js");

        // VARIABLE should NOT get CONTAINS edge
        assert!(contains_edges.iter().all(|e| !e.dst.contains("VARIABLE")));
    }

    #[test]
    fn ensure_function_contains_no_duplicates() {
        let mut analysis = FileAnalysis {
            file: "src/app.js".to_string(),
            module_id: "MODULE#src/app.js".to_string(),
            nodes: vec![
                GraphNode {
                    id: "FUNCTION#src/app.js:foo".to_string(),
                    node_type: "FUNCTION".to_string(),
                    name: "foo".to_string(),
                    file: "src/app.js".to_string(),
                    line: 1, column: 0, end_line: 5, end_column: 1,
                    exported: false,
                    metadata: HashMap::new(),
                    extra: HashMap::new(),
                },
            ],
            edges: vec![
                GraphEdge {
                    src: "MODULE#src/app.js".to_string(),
                    dst: "FUNCTION#src/app.js:foo".to_string(),
                    edge_type: "CONTAINS".to_string(),
                    metadata: HashMap::new(),
                },
            ],
            exports: vec![],
        };

        analysis.ensure_function_contains_edges();

        // No new edges added — already has CONTAINS
        let contains_count = analysis.edges.iter()
            .filter(|e| e.edge_type == "CONTAINS")
            .count();
        assert_eq!(contains_count, 1);
    }

    #[test]
    fn ensure_function_contains_empty_analysis() {
        let mut analysis = FileAnalysis {
            file: "empty.js".to_string(),
            module_id: "MODULE#empty.js".to_string(),
            nodes: vec![],
            edges: vec![],
            exports: vec![],
        };

        analysis.ensure_function_contains_edges();
        assert!(analysis.edges.is_empty());
    }

    // RFD-48: GraphNode captures unknown top-level fields in `extra`
    #[test]
    fn graphnode_extra_fields_captured() {
        let json = r#"{
            "id": "app.js->IMPORT->React",
            "type": "IMPORT",
            "name": "React",
            "file": "app.js",
            "line": 1,
            "column": 0,
            "exported": false,
            "metadata": {},
            "source": "react",
            "specifiers": ["React"]
        }"#;

        let node: GraphNode = serde_json::from_str(json).unwrap();
        assert_eq!(node.node_type, "IMPORT");
        assert_eq!(node.extra.get("source").and_then(|v| v.as_str()), Some("react"));
        assert!(node.extra.contains_key("specifiers"));
    }

    // RFD-48: extra fields end up in wire metadata
    #[test]
    fn to_wire_nodes_merges_extra_into_metadata() {
        let analysis = FileAnalysis {
            file: "app.js".to_string(),
            module_id: "app.js".to_string(),
            nodes: vec![GraphNode {
                id: "app.js->IMPORT->React".to_string(),
                node_type: "IMPORT".to_string(),
                name: "React".to_string(),
                file: "app.js".to_string(),
                line: 1,
                column: 0,
                end_line: 0,
                end_column: 0,
                exported: false,
                metadata: HashMap::new(),
                extra: {
                    let mut m = HashMap::new();
                    m.insert("source".to_string(), serde_json::json!("react"));
                    m.insert("specifiers".to_string(), serde_json::json!(["React"]));
                    m
                },
            }],
            edges: vec![],
            exports: vec![],
        };

        let wire = to_wire_nodes(&analysis);
        assert_eq!(wire.len(), 1);
        let meta: serde_json::Value =
            serde_json::from_str(wire[0].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["source"], "react");
        assert_eq!(meta["specifiers"][0], "React");
        // Standard fields also present
        assert_eq!(meta["line"], 1);
    }
}
