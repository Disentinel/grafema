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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Semaphore};

use crate::parser;
use crate::process_pool::{PoolConfig, ProcessPool};
use crate::rfdb::{WireEdge, WireNode};

static BACKPRESSURE_COUNT: AtomicU64 = AtomicU64::new(0);

/// Read and reset the backpressure counter (number of times channel was full).
pub fn read_backpressure_count() -> u64 {
    BACKPRESSURE_COUNT.swap(0, Ordering::Relaxed)
}

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
            node.name = strip(&node.name);
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

    /// Ensure FUNCTION/CLASS nodes have HAS_SCOPE edges to their scope nodes.
    ///
    /// JS analyzer creates SCOPE nodes with ID `{function_id}:scope` but doesn't
    /// emit `FUNCTION → HAS_SCOPE → SCOPE`. This makes it impossible to walk from
    /// a child node up to the enclosing FUNCTION via edges.
    pub fn ensure_function_scope_edges(&mut self) {
        let fn_ids: HashSet<String> = self
            .nodes
            .iter()
            .filter(|n| n.node_type == "FUNCTION" || n.node_type == "CLASS")
            .map(|n| n.id.clone())
            .collect();

        if fn_ids.is_empty() {
            return;
        }

        let scope_suffix = ":scope";
        let new_edges: Vec<GraphEdge> = self
            .nodes
            .iter()
            .filter(|n| n.node_type == "SCOPE" && n.id.ends_with(scope_suffix))
            .filter_map(|scope| {
                let fn_id = &scope.id[..scope.id.len() - scope_suffix.len()];
                if fn_ids.contains(fn_id) {
                    Some(GraphEdge {
                        src: fn_id.to_string(),
                        dst: scope.id.clone(),
                        edge_type: "HAS_SCOPE".to_string(),
                        metadata: HashMap::new(),
                    })
                } else {
                    None
                }
            })
            .collect();

        self.edges.extend(new_edges);
    }

    /// Mark nodes as exported if they appear in the file's exports list.
    ///
    /// The JS/TS analyzer may not set `exported: true` on FUNCTION/CLASS nodes
    /// for `export function foo()` due to AST walking order. This post-processing
    /// step cross-references `faExports` with nodes and sets the flag.
    pub fn ensure_exported_flags(&mut self) {
        let export_ids: HashSet<String> = self
            .exports
            .iter()
            .map(|e| e.node_id.clone())
            .collect();

        if export_ids.is_empty() {
            return;
        }

        let mut fixed = 0;
        for node in &mut self.nodes {
            if !node.exported && export_ids.contains(&node.id) {
                node.exported = true;
                fixed += 1;
            }
        }
        if fixed > 0 {
            tracing::debug!(fixed, file = %self.file, "Fixed exported flags from exports list");
        }
    }

    /// Convert byte-offset positions to line:column for all nodes.
    ///
    /// The JS/TS analyzer (Haskell `js-analyzer`) outputs byte offsets in the
    /// `line` and `endLine` fields, with `column` and `endColumn` always 0.
    /// This method reads the source file to build a line index and converts
    /// each node's positions to 1-based line and 0-based column.
    ///
    /// Must be called BEFORE `relativize_paths()` since it needs the absolute
    /// file path to read the source.
    pub fn convert_byte_offsets_to_lines(&mut self, file_path: &Path) {
        let content = match std::fs::read(file_path) {
            Ok(c) => c,
            Err(_) => return, // Can't read file, skip conversion
        };
        let line_index = build_line_index(&content);

        for node in &mut self.nodes {
            if node.line > 0 {
                let (line, col) = byte_offset_to_line_col(&line_index, node.line as usize);
                node.line = line;
                node.column = col;
            }
            if node.end_line > 0 {
                let (line, col) = byte_offset_to_line_col(&line_index, node.end_line as usize);
                node.end_line = line;
                node.end_column = col;
            }
        }
    }

    /// Convert all semantic IDs in this analysis to URI format.
    ///
    /// URI format: grafema://{authority}/{file}#{encoded_fragment}
    /// Virtual nodes (no file prefix): grafema://{authority}/_/{encoded_full_id}
    /// Module IDs: grafema://{authority}/{file}#MODULE
    pub fn to_uri_format(&mut self, authority: &str) {
        let convert = |id: &str| -> String {
            compact_to_uri(id, authority)
        };

        self.module_id = convert(&self.module_id);
        self.file = self.file.clone(); // file path stays as-is

        for node in &mut self.nodes {
            node.id = convert(&node.id);
            // node.file stays as relative path
        }
        for edge in &mut self.edges {
            edge.src = convert(&edge.src);
            edge.dst = convert(&edge.dst);
        }
        for export in &mut self.exports {
            export.node_id = convert(&export.node_id);
        }
    }
}

// ---------------------------------------------------------------------------
// Byte-offset → line:column conversion
// ---------------------------------------------------------------------------

/// Build an index of byte offsets for each line start.
///
/// `index[0] = 0` (first line starts at byte 0),
/// `index[1]` = position after first newline, etc.
fn build_line_index(content: &[u8]) -> Vec<usize> {
    let mut index = vec![0usize];
    for (i, &byte) in content.iter().enumerate() {
        if byte == b'\n' {
            index.push(i + 1);
        }
    }
    index
}

/// Convert a byte offset to 1-based line and 0-based column.
///
/// Uses binary search on the line index. Returns `(1, 0)` if the offset
/// is out of bounds (beyond end of file).
fn byte_offset_to_line_col(line_index: &[usize], offset: usize) -> (i64, i64) {
    match line_index.binary_search(&offset) {
        // Exact match: offset is at the start of a line
        Ok(line) => ((line + 1) as i64, 0),
        // Between two line starts: offset falls within line (insertion_point - 1)
        Err(insertion_point) => {
            if insertion_point == 0 {
                // Shouldn't happen since index[0] = 0, but handle gracefully
                (1, offset as i64)
            } else {
                let line_start = line_index[insertion_point - 1];
                (insertion_point as i64, (offset - line_start) as i64)
            }
        }
    }
}

/// Check whether a file path has a JS/TS extension (analyzed by Haskell js-analyzer
/// which outputs byte offsets instead of line:column).
pub fn is_js_ts_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext, "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts"))
        .unwrap_or(false)
}

/// Encode a fragment string for use in a grafema:// URI.
/// Only 4 chars need percent-encoding in fragments: > [ ] #
fn encode_fragment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 16);
    for ch in raw.chars() {
        match ch {
            '>' => out.push_str("%3E"),
            '[' => out.push_str("%5B"),
            ']' => out.push_str("%5D"),
            '#' => out.push_str("%23"),
            _ => out.push(ch),
        }
    }
    out
}

/// Convert a compact semantic ID to a grafema:// URI.
///
/// Handles three formats:
/// 1. `MODULE#file` → `grafema://{authority}/{file}#MODULE`
/// 2. `file->TYPE->rest` → `grafema://{authority}/{file}#TYPE->{rest}` (with encoding)
/// 3. Virtual nodes (no file prefix, e.g., `EXTERNAL_MODULE->lodash`, `net:stdio->__stdio__`) →
///    `grafema://{authority}/_/{encoded_full_id}`
fn compact_to_uri(id: &str, authority: &str) -> String {
    // Case 1: MODULE#file format
    if let Some(file) = id.strip_prefix("MODULE#") {
        return format!("grafema://{authority}/{file}#MODULE");
    }

    // Case 2 & 3: Check for file->TYPE->rest pattern
    // The file part is everything before the first '->'
    if let Some(first_arrow) = id.find("->") {
        let before_arrow = &id[..first_arrow];

        // Virtual nodes have no file path — they start with uppercase type or special prefix
        // Examples: EXTERNAL_MODULE->lodash, GLOBAL::console, net:stdio->__stdio__
        // Heuristic: if the part before '->' contains a '/' or '.', it's a file path
        let is_file_path = before_arrow.contains('/') || before_arrow.contains('.');

        if is_file_path {
            // Standard node: file->REST
            let file = before_arrow;
            let rest = &id[first_arrow + 2..]; // TYPE->name[...] part
            let encoded = encode_fragment(rest);
            format!("grafema://{authority}/{file}#{encoded}")
        } else {
            // Virtual node: encode the whole ID
            let encoded = encode_fragment(id);
            format!("grafema://{authority}/_/{encoded}")
        }
    } else {
        // No arrow at all — treat as virtual
        let encoded = encode_fragment(id);
        format!("grafema://{authority}/_/{encoded}")
    }
}

// ---------------------------------------------------------------------------
// AnalysisResult — per-file outcome
// ---------------------------------------------------------------------------

/// A structured issue discovered during analysis (oversized file, parse error, etc.).
/// Converted to ISSUE nodes in the graph via `issues_to_wire()`.
#[derive(Debug, Clone)]
pub struct AnalysisIssue {
    /// Category: `oversized_source`, `oversized_ast`, `parse_error`, `analysis_error`
    pub category: String,
    /// `warning` (size guards) or `error` (parse/analysis failures)
    pub severity: String,
    /// Human-readable description
    pub message: String,
    /// Source file (relative or absolute — relativized later in ingest_chunk)
    pub file: String,
}

/// Result of analyzing a single file. Contains either a successful `FileAnalysis`
/// or collected error messages (parse errors, analyzer failures, etc.).
/// Both fields may be populated: parse errors are collected even when a partial
/// AST produces a valid analysis.
pub struct AnalysisResult {
    pub file: PathBuf,
    pub analysis: Option<FileAnalysis>,
    pub errors: Vec<String>,
    /// Structured issues to persist as ISSUE nodes in the graph.
    pub issues: Vec<AnalysisIssue>,
    /// Performance metrics for this file's analysis.
    pub metrics: FileMetrics,
}

/// Per-file performance metrics captured during analysis.
/// Carried in-band via `AnalysisResult` so main.rs can emit profiler events
/// without passing the profiler into inner functions.
#[derive(Debug, Default)]
pub struct FileMetrics {
    pub file_size_bytes: u64,
    pub ast_size_bytes: u64,
    pub parse_ms: u64,
    pub analyze_ms: u64,
    pub total_ms: u64,
    pub node_count: usize,
    pub edge_count: usize,
    // Semantic density metrics
    pub decl_count: usize,
    pub ref_count: usize,
    pub call_count: usize,
    pub prop_count: usize,
}

impl FileMetrics {
    /// Populate semantic density counts from the analysis result's nodes.
    /// Counts declarations (FUNCTION, METHOD, CLASS, VARIABLE, CONSTANT),
    /// references (REFERENCE), calls (CALL), and property accesses (PROPERTY_ACCESS).
    pub fn fill_density(&mut self, analysis: &Option<FileAnalysis>) {
        if let Some(a) = analysis {
            for node in &a.nodes {
                match node.node_type.as_str() {
                    "FUNCTION" | "METHOD" | "CLASS" | "VARIABLE" | "CONSTANT" => self.decl_count += 1,
                    "REFERENCE" => self.ref_count += 1,
                    "CALL" => self.call_count += 1,
                    "PROPERTY_ACCESS" => self.prop_count += 1,
                    _ => {}
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Size guards
// ---------------------------------------------------------------------------

use crate::config::SizeLimits;

/// Check source file size against the configured limit.
/// Returns `Some(issue)` if the file exceeds `limits.max_file_bytes` (and the limit is non-zero).
pub fn check_file_size(file: &Path, limits: SizeLimits) -> Option<AnalysisIssue> {
    if limits.max_file_bytes == 0 {
        return None;
    }
    let size = match std::fs::metadata(file) {
        Ok(m) => m.len(),
        Err(_) => return None, // let downstream handle missing files
    };
    if size > limits.max_file_bytes {
        Some(AnalysisIssue {
            category: "oversized_source".to_string(),
            severity: "warning".to_string(),
            message: format!(
                "Source file too large: {} KB (limit: {} KB)",
                size / 1024,
                limits.max_file_bytes / 1024
            ),
            file: file.display().to_string(),
        })
    } else {
        None
    }
}

/// Check AST JSON size against the configured limit.
/// Returns `Some(issue)` if the AST exceeds `limits.max_ast_bytes` (and the limit is non-zero).
pub fn check_ast_size(file_display: &str, ast_size: usize, limits: SizeLimits) -> Option<AnalysisIssue> {
    if limits.max_ast_bytes == 0 {
        return None;
    }
    if ast_size as u64 > limits.max_ast_bytes {
        Some(AnalysisIssue {
            category: "oversized_ast".to_string(),
            severity: "warning".to_string(),
            message: format!(
                "AST too large: {} KB (limit: {} KB)",
                ast_size / 1024,
                limits.max_ast_bytes / 1024
            ),
            file: file_display.to_string(),
        })
    } else {
        None
    }
}

/// Convert analysis issues into RFDB wire nodes and edges.
///
/// For each issue, creates:
/// - An ISSUE node with category/severity/message metadata
/// - A CONTAINS edge from the MODULE stub to the ISSUE node
///
/// If `include_module_stub` is true (analysis failed completely), also creates
/// a MODULE stub so the file appears in graph queries and file-scoped GC works.
pub fn issues_to_wire(
    issues: &[AnalysisIssue],
    file: &str,
    authority: &str,
    include_module_stub: bool,
) -> (Vec<WireNode>, Vec<WireEdge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();

    if issues.is_empty() {
        return (nodes, edges);
    }

    let module_id = compact_to_uri(&format!("MODULE#{file}"), authority);

    if include_module_stub {
        nodes.push(WireNode {
            id: module_id.clone(),
            semantic_id: Some(module_id.clone()),
            node_type: Some("MODULE".to_string()),
            name: Some(file.to_string()),
            file: Some(file.to_string()),
            exported: false,
            metadata: None,
        });
    }

    for issue in issues {
        // Hash first 8 hex chars of blake3(message) for uniqueness
        let hash = blake3::hash(issue.message.as_bytes());
        let hash8 = &hash.to_hex()[..8];
        let compact_id = format!("{file}->ISSUE->{category}::{hash8}", category = issue.category);
        let issue_id = compact_to_uri(&compact_id, authority);

        let mut meta = HashMap::new();
        meta.insert("category".to_string(), serde_json::json!(issue.category));
        meta.insert("severity".to_string(), serde_json::json!(issue.severity));
        meta.insert("message".to_string(), serde_json::json!(issue.message));

        nodes.push(WireNode {
            id: issue_id.clone(),
            semantic_id: Some(issue_id.clone()),
            node_type: Some("ISSUE".to_string()),
            name: Some(format!("{}: {}", issue.category, issue.severity)),
            file: Some(file.to_string()),
            exported: false,
            metadata: Some(serde_json::to_string(&meta).unwrap()),
        });

        edges.push(WireEdge {
            src: module_id.clone(),
            dst: issue_id,
            edge_type: "CONTAINS".to_string(),
            metadata: None,
        });
    }

    (nodes, edges)
}

// ---------------------------------------------------------------------------
// Unresolved diagnostics → ISSUE wire nodes
// ---------------------------------------------------------------------------

/// Generate ISSUE nodes for unresolved calls and imports.
///
/// Each unresolved node is categorized:
/// - `unresolved_external` (severity=info): target likely outside analyzed root
/// - `unresolved_internal` (severity=warning): target file exists but symbol not resolved
///
/// Returns wire nodes and edges on synthetic file `__grafema_virtual/unresolved-diagnostics`.
pub fn unresolved_diagnostics_to_wire(
    unresolved: &[(String, String, String)], // (node_id, name, file)
    file_set: &HashSet<String>,
    authority: &str,
) -> (Vec<WireNode>, Vec<WireEdge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();

    if unresolved.is_empty() {
        return (nodes, edges);
    }

    let synthetic_file = "__grafema_virtual/unresolved-diagnostics";
    let module_id = compact_to_uri(&format!("MODULE#{synthetic_file}"), authority);

    // Create MODULE stub for the synthetic file
    nodes.push(WireNode {
        id: module_id.clone(),
        semantic_id: Some(module_id.clone()),
        node_type: Some("MODULE".to_string()),
        name: Some(synthetic_file.to_string()),
        file: Some(synthetic_file.to_string()),
        exported: false,
        metadata: None,
    });

    for (node_id, name, file) in unresolved {
        // Extract a plausible target path from the name field.
        // Patterns: "./billing_endpoint", "../utils/helper", "express", "lodash/get"
        let target = name
            .trim_start_matches("./")
            .trim_start_matches("../");

        // Check if any file in the analyzed set matches the target.
        // A match means the target file is in the graph but symbol resolution failed.
        let is_internal = file_set.iter().any(|f| {
            f.ends_with(target) || f.contains(target)
        });

        let (category, severity, message) = if is_internal {
            (
                "unresolved_internal",
                "warning",
                format!(
                    "Unresolved symbol '{}' in file '{}': target file exists in graph but symbol not resolved (node: {})",
                    name, file, node_id
                ),
            )
        } else {
            (
                "unresolved_external",
                "info",
                format!(
                    "Unresolved symbol '{}' in file '{}': target likely outside analyzed root (node: {})",
                    name, file, node_id
                ),
            )
        };

        let hash = blake3::hash(message.as_bytes());
        let hash8 = &hash.to_hex()[..8];
        let compact_id = format!("{synthetic_file}->ISSUE->{category}::{hash8}");
        let issue_id = compact_to_uri(&compact_id, authority);

        let mut meta = HashMap::new();
        meta.insert("category".to_string(), serde_json::json!(category));
        meta.insert("severity".to_string(), serde_json::json!(severity));
        meta.insert("message".to_string(), serde_json::json!(message));
        meta.insert("source_node".to_string(), serde_json::json!(node_id));
        meta.insert("source_file".to_string(), serde_json::json!(file));
        meta.insert("symbol_name".to_string(), serde_json::json!(name));

        nodes.push(WireNode {
            id: issue_id.clone(),
            semantic_id: Some(issue_id.clone()),
            node_type: Some("ISSUE".to_string()),
            name: Some(format!("{category}: {severity}")),
            file: Some(synthetic_file.to_string()),
            exported: false,
            metadata: Some(serde_json::to_string(&meta).unwrap()),
        });

        edges.push(WireEdge {
            src: module_id.clone(),
            dst: issue_id,
            edge_type: "CONTAINS".to_string(),
            metadata: None,
        });
    }

    (nodes, edges)
}

// ---------------------------------------------------------------------------
// Metrics → wire nodes
// ---------------------------------------------------------------------------

/// Metric definition: name, unit, and extractor from `FileMetrics`.
struct MetricDef {
    name: &'static str,
    unit: &'static str,
    extract: fn(&FileMetrics) -> u64,
}

const FILE_METRIC_DEFS: &[MetricDef] = &[
    MetricDef { name: "parse_ms",        unit: "ms",    extract: |m| m.parse_ms },
    MetricDef { name: "analyze_ms",      unit: "ms",    extract: |m| m.analyze_ms },
    MetricDef { name: "total_ms",        unit: "ms",    extract: |m| m.total_ms },
    MetricDef { name: "file_size_bytes", unit: "bytes", extract: |m| m.file_size_bytes },
    MetricDef { name: "ast_size_bytes",  unit: "bytes", extract: |m| m.ast_size_bytes },
    MetricDef { name: "node_count",      unit: "count", extract: |m| m.node_count as u64 },
    MetricDef { name: "edge_count",      unit: "count", extract: |m| m.edge_count as u64 },
    MetricDef { name: "decl_count",      unit: "count", extract: |m| m.decl_count as u64 },
    MetricDef { name: "ref_count",       unit: "count", extract: |m| m.ref_count as u64 },
    MetricDef { name: "call_count",      unit: "count", extract: |m| m.call_count as u64 },
    MetricDef { name: "prop_count",      unit: "count", extract: |m| m.prop_count as u64 },
];

/// Convert per-file performance metrics into RFDB wire nodes and edges.
///
/// For each non-zero metric in `FileMetrics`, creates:
/// - A METRIC node with value/unit/source metadata
/// - An OBSERVES edge from the METRIC node to the file's MODULE node
pub fn metrics_to_wire(
    metrics: &FileMetrics,
    file: &str,
    authority: &str,
) -> (Vec<WireNode>, Vec<WireEdge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();

    let module_id = compact_to_uri(&format!("MODULE#{file}"), authority);

    for def in FILE_METRIC_DEFS {
        let value = (def.extract)(metrics);
        if value == 0 {
            continue;
        }

        let compact_id = format!("{file}->METRIC->{}", def.name);
        let metric_id = compact_to_uri(&compact_id, authority);

        let mut meta = HashMap::new();
        meta.insert("value".to_string(), serde_json::json!(value));
        meta.insert("unit".to_string(), serde_json::json!(def.unit));
        meta.insert("source".to_string(), serde_json::json!("orchestrator"));

        nodes.push(WireNode {
            id: metric_id.clone(),
            semantic_id: Some(metric_id.clone()),
            node_type: Some("METRIC".to_string()),
            name: Some(def.name.to_string()),
            file: Some(file.to_string()),
            exported: false,
            metadata: Some(serde_json::to_string(&meta).unwrap()),
        });

        edges.push(WireEdge {
            src: metric_id,
            dst: module_id.clone(),
            edge_type: "OBSERVES".to_string(),
            metadata: None,
        });
    }

    (nodes, edges)
}

/// Convert pipeline-level phase metrics into RFDB wire nodes.
///
/// Phase metrics use synthetic file `__grafema_perf/{phase}` for proper
/// GC tombstoning. No OBSERVES edges — phase metrics observe the pipeline,
/// not a specific module.
pub fn phase_metrics_to_wire(
    phase_metrics: &[(&str, &str, u64, &str)], // (phase, metric_name, value, unit)
    authority: &str,
) -> (Vec<WireNode>, Vec<WireEdge>) {
    let mut nodes = Vec::new();

    for &(phase, metric_name, value, unit) in phase_metrics {
        if value == 0 {
            continue;
        }

        let synthetic_file = format!("__grafema_perf/{phase}");
        let compact_id = format!("{synthetic_file}->METRIC->{metric_name}");
        let metric_id = compact_to_uri(&compact_id, authority);

        let mut meta = HashMap::new();
        meta.insert("value".to_string(), serde_json::json!(value));
        meta.insert("unit".to_string(), serde_json::json!(unit));
        meta.insert("source".to_string(), serde_json::json!("orchestrator"));
        meta.insert("phase".to_string(), serde_json::json!(phase));

        nodes.push(WireNode {
            id: metric_id.clone(),
            semantic_id: Some(metric_id.clone()),
            node_type: Some("METRIC".to_string()),
            name: Some(metric_name.to_string()),
            file: Some(synthetic_file),
            exported: false,
            metadata: Some(serde_json::to_string(&meta).unwrap()),
        });
    }

    (nodes, Vec::new())
}

// ---------------------------------------------------------------------------
// Profile subgraph → wire nodes  (pipeline profiling as a queryable subgraph)
// ---------------------------------------------------------------------------

/// A single pipeline stage extracted from the profiler event stream: an
/// analyzer / resolver-cmd / derive-pack / enricher with its measured wall time
/// and edge/node production. Stages are ordered by `elapsed_ms` (execution
/// order) within their phase; consecutive stages get a `PRECEDES` edge so the
/// "route" can be walked, and the critical path = the longest `PRECEDES` chain
/// summed by `wall_ms`.
#[derive(Debug, Clone)]
pub struct ProfileStage {
    /// Phase this stage belongs to: "analysis" | "resolve" | "derive" | "enrich".
    pub phase: &'static str,
    /// Stage kind, recorded as `kind` metadata: "resolver" | "derive_pack" | "enricher".
    pub kind: &'static str,
    /// Stage name (e.g. "@stdlib/depends", "js-resolution").
    pub name: String,
    /// Wall time in ms.
    pub wall_ms: u64,
    /// Edges this stage produced (the dead-stage signal: high wall + 0 edges).
    pub edges_produced: u64,
    /// Nodes this stage produced (may be 0 / unknown for some stages).
    pub nodes_produced: u64,
    /// Order key — profiler `elapsed_ms` at completion (execution order).
    pub order: u128,
}

/// Pipeline-level summary used to fill the profile:run node.
#[derive(Debug, Clone)]
pub struct ProfileRunSummary {
    /// Wall-clock total for the whole analyze, ms.
    pub total_ms: u64,
    /// ISO timestamp of the run.
    pub ts: String,
}

/// Build the **profile subgraph** from collected pipeline stages:
///
/// - one `profile:run` node (attrs `ts`, `total_ms`)
/// - one `profile:phase` node per distinct phase, `PART_OF` → run
/// - one `profile:stage` node per stage, `PART_OF` → its phase, with a
///   `PRECEDES` edge to the next stage in the same phase (execution order)
/// - `METRIC` nodes (REUSING the existing METRIC node type + `OBSERVES` edge):
///   one per measure (`wall_ms`, `edges_produced`, `nodes_produced`) `OBSERVES`
///   → its stage. Per-phase `wall_ms` METRIC `OBSERVES` → the phase.
///
/// All graph ids live under the synthetic `__grafema_profile/{run_ts}` file so
/// they tombstone cleanly and never collide with code nodes. Node types are
/// `profile:*` so code queries that filter by `FUNCTION`/`MODULE`/… ignore them.
pub fn profile_subgraph_to_wire(
    run: &ProfileRunSummary,
    stages: &[ProfileStage],
    authority: &str,
) -> (Vec<WireNode>, Vec<WireEdge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();

    // Stable-but-unique-per-run namespace. Using the timestamp keeps the run id
    // deterministic within a run and tombstonable on the next analyze.
    let run_key = run.ts.replace([':', '-'], "");
    let synthetic_file = format!("__grafema_profile/{run_key}");

    let run_id = compact_to_uri(&format!("{synthetic_file}->profile:run->{run_key}"), authority);

    // --- profile:run ---
    {
        let mut meta = HashMap::new();
        meta.insert("ts".to_string(), serde_json::json!(run.ts));
        meta.insert("total_ms".to_string(), serde_json::json!(run.total_ms));
        meta.insert("source".to_string(), serde_json::json!("profiler"));
        nodes.push(WireNode {
            id: run_id.clone(),
            semantic_id: Some(run_id.clone()),
            node_type: Some("profile:run".to_string()),
            name: Some(format!("analyze@{}", run.ts)),
            file: Some(synthetic_file.clone()),
            exported: false,
            metadata: Some(serde_json::to_string(&meta).unwrap()),
        });
    }

    // Helper: build a METRIC node + OBSERVES edge to `observed`.
    let push_metric =
        |nodes: &mut Vec<WireNode>, edges: &mut Vec<WireEdge>, observed: &str, slug: &str,
         measure: &str, value: u64, unit: &str| {
            let metric_id = compact_to_uri(
                &format!("{synthetic_file}->METRIC->{slug}::{measure}"),
                authority,
            );
            let mut meta = HashMap::new();
            meta.insert("value".to_string(), serde_json::json!(value));
            meta.insert("unit".to_string(), serde_json::json!(unit));
            meta.insert("source".to_string(), serde_json::json!("profiler"));
            nodes.push(WireNode {
                id: metric_id.clone(),
                semantic_id: Some(metric_id.clone()),
                node_type: Some("METRIC".to_string()),
                name: Some(measure.to_string()),
                file: Some(synthetic_file.clone()),
                exported: false,
                metadata: Some(serde_json::to_string(&meta).unwrap()),
            });
            edges.push(WireEdge {
                src: metric_id,
                dst: observed.to_string(),
                edge_type: "OBSERVES".to_string(),
                metadata: None,
            });
        };

    // Distinct phases in first-seen order.
    let mut phase_order: Vec<&'static str> = Vec::new();
    for s in stages {
        if !phase_order.contains(&s.phase) {
            phase_order.push(s.phase);
        }
    }

    // --- profile:phase nodes + PART_OF run ---
    let mut phase_ids: HashMap<&'static str, String> = HashMap::new();
    for phase in &phase_order {
        let phase_id =
            compact_to_uri(&format!("{synthetic_file}->profile:phase->{phase}"), authority);
        let phase_wall: u64 = stages.iter().filter(|s| s.phase == *phase).map(|s| s.wall_ms).sum();
        let mut meta = HashMap::new();
        meta.insert("phase".to_string(), serde_json::json!(phase));
        meta.insert("source".to_string(), serde_json::json!("profiler"));
        nodes.push(WireNode {
            id: phase_id.clone(),
            semantic_id: Some(phase_id.clone()),
            node_type: Some("profile:phase".to_string()),
            name: Some(phase.to_string()),
            file: Some(synthetic_file.clone()),
            exported: false,
            metadata: Some(serde_json::to_string(&meta).unwrap()),
        });
        edges.push(WireEdge {
            src: phase_id.clone(),
            dst: run_id.clone(),
            edge_type: "PART_OF".to_string(),
            metadata: None,
        });
        push_metric(&mut nodes, &mut edges, &phase_id, &format!("phase::{phase}"), "wall_ms", phase_wall, "ms");
        phase_ids.insert(phase, phase_id);
    }

    // --- profile:stage nodes per phase, in execution order, with PRECEDES ---
    for phase in &phase_order {
        let mut phase_stages: Vec<&ProfileStage> =
            stages.iter().filter(|s| s.phase == *phase).collect();
        phase_stages.sort_by_key(|s| s.order);

        let phase_id = phase_ids.get(phase).cloned().unwrap_or_default();
        let mut prev_stage_id: Option<String> = None;

        for (i, st) in phase_stages.iter().enumerate() {
            // Slug must be unique within the run; include phase + index since a
            // pack/cmd name could repeat across phases.
            let slug = format!("{phase}.{i}.{}", sanitize_stage(&st.name));
            let stage_id =
                compact_to_uri(&format!("{synthetic_file}->profile:stage->{slug}"), authority);

            let mut meta = HashMap::new();
            meta.insert("phase".to_string(), serde_json::json!(st.phase));
            meta.insert("kind".to_string(), serde_json::json!(st.kind));
            meta.insert("wall_ms".to_string(), serde_json::json!(st.wall_ms));
            meta.insert("edges_produced".to_string(), serde_json::json!(st.edges_produced));
            meta.insert("nodes_produced".to_string(), serde_json::json!(st.nodes_produced));
            meta.insert("order".to_string(), serde_json::json!(i));
            meta.insert("source".to_string(), serde_json::json!("profiler"));

            nodes.push(WireNode {
                id: stage_id.clone(),
                semantic_id: Some(stage_id.clone()),
                node_type: Some("profile:stage".to_string()),
                name: Some(st.name.clone()),
                file: Some(synthetic_file.clone()),
                exported: false,
                metadata: Some(serde_json::to_string(&meta).unwrap()),
            });

            // PART_OF → phase
            edges.push(WireEdge {
                src: stage_id.clone(),
                dst: phase_id.clone(),
                edge_type: "PART_OF".to_string(),
                metadata: None,
            });

            // METRIC nodes OBSERVES → stage
            push_metric(&mut nodes, &mut edges, &stage_id, &slug, "wall_ms", st.wall_ms, "ms");
            push_metric(&mut nodes, &mut edges, &stage_id, &slug, "edges_produced", st.edges_produced, "count");
            push_metric(&mut nodes, &mut edges, &stage_id, &slug, "nodes_produced", st.nodes_produced, "count");

            // PRECEDES from previous stage in this phase (the route).
            if let Some(prev) = prev_stage_id.take() {
                edges.push(WireEdge {
                    src: prev,
                    dst: stage_id.clone(),
                    edge_type: "PRECEDES".to_string(),
                    metadata: None,
                });
            }
            prev_stage_id = Some(stage_id);
        }
    }

    (nodes, edges)
}

/// Make a stage name safe for use inside a compact semantic id (no `->`, `/`,
/// `:` that would confuse `compact_to_uri`'s file/type split).
fn sanitize_stage(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect()
}

// ---------------------------------------------------------------------------
// Workspace packages → wire nodes (Wave 3c)
// ---------------------------------------------------------------------------

/// Convert the discovered workspace-package map (config.rs `services` discovery
/// plus alias-expanded virtual packages) into `WORKSPACE_PACKAGE` wire nodes —
/// the graph facts the datalog packs join on (`js_module_imports` workspace
/// arms: `attr(W, "name", <npm name>)` × `attr(W, "file", <entry point>)`).
///
/// Conventions (resolve-migration synthesis doc §4 item 3):
/// - `name` = the npm package name (e.g. `"@grafema/util"`);
/// - `file` = the entry point relative to the project root (the field the
///   workspace arms join — and what ties the fact's lifecycle to the entry
///   file: re-analyzing it tombstones the node, and the per-run re-emission
///   below restores it before the pack phase);
/// - `metadata.package_dir` = the package directory (carried for future
///   arms; the legacy sub-path arm uses `dirname(entry_point)`, not this —
///   ImportResolution.hs:195-200).
///
/// Semantic ids are `{entry_point}->WORKSPACE_PACKAGE->{name}` (the standard
/// `file->TYPE->name` shape, stable across runs).
pub fn workspace_packages_to_wire(
    packages: &[crate::plugin::WorkspacePackageWire],
    authority: &str,
) -> Vec<WireNode> {
    let mut nodes = Vec::new();
    for pkg in packages {
        let compact_id = format!("{}->WORKSPACE_PACKAGE->{}", pkg.entry_point, pkg.name);
        let node_id = compact_to_uri(&compact_id, authority);

        let mut meta = HashMap::new();
        meta.insert("package_dir".to_string(), serde_json::json!(pkg.package_dir));

        nodes.push(WireNode {
            id: node_id.clone(),
            semantic_id: Some(node_id),
            node_type: Some("WORKSPACE_PACKAGE".to_string()),
            name: Some(pkg.name.clone()),
            file: Some(pkg.entry_point.clone()),
            exported: false,
            metadata: Some(serde_json::to_string(&meta).unwrap()),
        });
    }
    nodes
}

/// The GO module-path fact (precondition P1 of the go pack migration): the
/// go.mod module path the legacy `go-resolve` daemon consumed over the wire
/// (`workspace_packages` — main.rs wraps `discover_go_module_path` as a single
/// WorkspacePackageWire) becomes a graph fact the go packs can join:
/// `go_mod(MP) :- node(W, "WORKSPACE_PACKAGE"), node_attr(W, "language", "go"),
/// attr(W, "name", MP)` (go_imports.dl / go_calls.dl).
///
/// Shape (the [`workspace_packages_to_wire`] conventions, plus the language
/// discriminator):
/// - `name` = the Go module path (e.g. `"github.com/user/project"`);
/// - `file` = `"go.mod"` (the declaring file — js workspace facts never carry
///   it, so the js packs' `ws_pkg` arms cannot confuse the fact with an npm
///   package, and vice versa the go packs key on `language`);
/// - `metadata.language` = `"go"` — the discriminator the packs join;
/// - `metadata.package_dir` = the project root.
///
/// Semantic id `go.mod->WORKSPACE_PACKAGE-><module path>` (stable across runs;
/// re-emitted every analyze like the js facts — upsert dedups).
pub fn go_module_workspace_fact(module_path: &str, root: &str, authority: &str) -> WireNode {
    let compact_id = format!("go.mod->WORKSPACE_PACKAGE->{module_path}");
    let node_id = compact_to_uri(&compact_id, authority);

    let mut meta = HashMap::new();
    meta.insert("language".to_string(), serde_json::json!("go"));
    meta.insert("package_dir".to_string(), serde_json::json!(root));

    WireNode {
        id: node_id.clone(),
        semantic_id: Some(node_id),
        node_type: Some("WORKSPACE_PACKAGE".to_string()),
        name: Some(module_path.to_string()),
        file: Some("go.mod".to_string()),
        exported: false,
        metadata: Some(serde_json::to_string(&meta).unwrap()),
    }
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
// BEAM single-file analysis
// ---------------------------------------------------------------------------

/// Analyze a single BEAM (Elixir/Erlang) file: read source, run beam-analyzer, return FileAnalysis.
///
/// Like Haskell analysis, there is no OXC parsing step — `beam-analyzer` parses
/// internally. The payload sent to stdin is `{"file":"<filepath>","source":"<source_text>"}`.
///
/// Returns `Err` if the file cannot be read, the analyzer binary cannot be
/// spawned, the analyzer exits non-zero, or its output is not valid
/// `FileAnalysis` JSON.
pub async fn analyze_beam_file(file: &Path, analyzer_bin: &str) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read BEAM source file {file_str}"))?;

    let mut child = tokio::process::Command::new(analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn beam-analyzer for {file_str}"))?;

    // Build JSON payload: {"file":"...","source":"..."}
    let payload = serde_json::json!({
        "file": file_str,
        "source": source,
    });

    {
        let stdin = child
            .stdin
            .as_mut()
            .context("Failed to open stdin for beam-analyzer")?;
        stdin
            .write_all(payload.to_string().as_bytes())
            .await
            .with_context(|| {
                format!("Failed to write source to beam-analyzer stdin for {file_str}")
            })?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close beam-analyzer stdin for {file_str}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for beam-analyzer for {file_str}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        anyhow::bail!(
            "beam-analyzer exited with code {code} for {file_str}: {stderr}"
        );
    }

    let stdout = &output.stdout;
    let analysis: FileAnalysis = serde_json::from_slice(stdout).with_context(|| {
        let preview = String::from_utf8_lossy(&stdout[..stdout.len().min(200)]);
        format!(
            "Failed to parse beam-analyzer output as FileAnalysis for {file_str}: {preview}"
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

/// Analyze a single BEAM (Elixir/Erlang) file via a persistent daemon process pool.
///
/// Reads the source file from disk, builds a `{"file":"...","source":"..."}`
/// JSON request via string concatenation (avoids parsing the source into Value),
/// sends it as a length-prefixed frame through the pool, and parses the JSON
/// response.
pub async fn analyze_beam_file_pooled(
    pool: &ProcessPool,
    file: &Path,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read BEAM source file {file_str}"))?;

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
            bail!("beam-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown daemon response status '{other}' for {file_str}"),
    }
}

/// Analyze a single JS/TS file: OXC parse → daemon pool request → AnalysisResult.
///
/// Extracted from `analyze_files_parallel_pooled` so both the Vec-collecting and
/// channel-streaming variants can reuse the same per-file logic.
async fn analyze_single_js_file(
    pool: Arc<ProcessPool>,
    file: PathBuf,
    idx: usize,
    total: usize,
    limits: SizeLimits,
) -> AnalysisResult {
    let file_display = file.display().to_string();
    let file_start = std::time::Instant::now();

    // Get file size for metrics
    let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

    // Log milestones (every 100 files), or every file for small batches
    if total <= 100 || (idx + 1) % 100 == 0 || idx + 1 == total {
        tracing::info!("[{}/{}] Analyzing {}", idx + 1, total, file_display);
    } else {
        tracing::debug!("[{}/{}] Analyzing {}", idx + 1, total, file_display);
    }

    let mut errors = Vec::new();
    let mut issues = Vec::new();

    // Size guard: check source file size before parsing
    if let Some(issue) = check_file_size(&file, limits) {
        tracing::warn!(
            file = %file_display,
            "Skipping oversized source file: {}",
            issue.message
        );
        issues.push(issue);
        return AnalysisResult {
            file,
            analysis: None,
            errors,
            issues,
            metrics: FileMetrics {
                file_size_bytes,
                total_ms: file_start.elapsed().as_millis() as u64,
                ..FileMetrics::default()
            },
        };
    }

    // Step 1: Parse with OXC (CPU-bound -> spawn_blocking)
    let parse_result = {
        let file_clone = file.clone();
        tokio::task::spawn_blocking(move || parser::parse_file(&file_clone)).await
    };

    let parse_ms = file_start.elapsed().as_millis();

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
            let msg = format!("Parse failed for {file_display}: {e}");
            errors.push(msg.clone());
            issues.push(AnalysisIssue {
                category: "parse_error".to_string(),
                severity: "error".to_string(),
                message: msg,
                file: file_display.clone(),
            });
            tracing::warn!("[{}/{}] FAILED parse {}ms {}", idx + 1, total, parse_ms, file_display);
            return AnalysisResult {
                file,
                analysis: None,
                errors,
                issues,
                metrics: FileMetrics {
                    file_size_bytes,
                    parse_ms: parse_ms as u64,
                    total_ms: file_start.elapsed().as_millis() as u64,
                    ..FileMetrics::default()
                },
            };
        }
        Err(e) => {
            let msg = format!("Parse task panicked for {file_display}: {e}");
            errors.push(msg.clone());
            issues.push(AnalysisIssue {
                category: "parse_error".to_string(),
                severity: "error".to_string(),
                message: msg,
                file: file_display.clone(),
            });
            tracing::error!("[{}/{}] PANIC parse {}ms {}", idx + 1, total, parse_ms, file_display);
            return AnalysisResult {
                file,
                analysis: None,
                errors,
                issues,
                metrics: FileMetrics {
                    file_size_bytes,
                    parse_ms: parse_ms as u64,
                    total_ms: file_start.elapsed().as_millis() as u64,
                    ..FileMetrics::default()
                },
            };
        }
    };

    let ast_size = ast_json.len();

    // Size guard: check AST size before sending to daemon
    if let Some(issue) = check_ast_size(&file_display, ast_size, limits) {
        tracing::warn!(
            file = %file_display,
            ast_kb = ast_size / 1024,
            "Skipping oversized AST"
        );
        issues.push(issue);
        return AnalysisResult {
            file,
            analysis: None,
            errors,
            issues,
            metrics: FileMetrics {
                file_size_bytes,
                ast_size_bytes: ast_size as u64,
                parse_ms: parse_ms as u64,
                total_ms: file_start.elapsed().as_millis() as u64,
                ..FileMetrics::default()
            },
        };
    }

    // Step 2: Send to daemon pool
    let analyze_start = std::time::Instant::now();
    let mut result = match analyze_file_pooled(&pool, &file, &ast_json).await {
        Ok(analysis) => AnalysisResult {
            file,
            analysis: Some(analysis),
            errors,
            issues,
            metrics: FileMetrics::default(),
        },
        Err(e) => {
            let msg = format!("Analyzer failed for {file_display}: {e}");
            errors.push(msg.clone());
            issues.push(AnalysisIssue {
                category: "analysis_error".to_string(),
                severity: "error".to_string(),
                message: msg,
                file: file_display.clone(),
            });
            AnalysisResult {
                file,
                analysis: None,
                errors,
                issues,
                metrics: FileMetrics::default(),
            }
        }
    };

    let analyze_ms = analyze_start.elapsed().as_millis() as u64;
    let total_ms = file_start.elapsed().as_millis();

    let (node_count, edge_count) = match &result.analysis {
        Some(a) => (a.nodes.len(), a.edges.len()),
        None => (0, 0),
    };

    result.metrics = FileMetrics {
        file_size_bytes,
        ast_size_bytes: ast_size as u64,
        parse_ms: parse_ms as u64,
        analyze_ms,
        total_ms: total_ms as u64,
        node_count,
        edge_count,
        ..Default::default()
    };

    // Log slow files (>5s) at info level, rest at debug
    if total_ms > 5000 {
        tracing::warn!(
            "[{}/{}] SLOW {}ms (parse={}ms, ast={}KB) {}",
            idx + 1, total, total_ms, parse_ms,
            ast_size / 1024, file_display
        );
    } else if total <= 100 || (idx + 1) % 100 == 0 || idx + 1 == total {
        tracing::info!(
            "[{}/{}] Done {}ms {}",
            idx + 1, total, total_ms, file_display
        );
    } else {
        tracing::debug!(
            "[{}/{}] Done {}ms {}",
            idx + 1, total, total_ms, file_display
        );
    }

    result
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
    limits: SizeLimits,
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

            tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .expect("Semaphore closed unexpectedly");
                analyze_single_js_file(pool, file, idx, total, limits).await
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    pool.shutdown().await;
    results
}

/// Analyze JS/TS files with streaming output: results are sent through a channel
/// as each file completes, enabling double-buffered ingestion.
///
/// Analysis and RFDB ingestion run in parallel: while the receiver batches and
/// commits results to RFDB, analysis continues filling the channel. The bounded
/// channel provides backpressure — if ingestion is slow, analysis pauses.
///
/// Takes ownership of `files` because this function is designed to be spawned
/// into a `tokio::spawn` task.
pub async fn analyze_js_files_streaming(
    files: Vec<PathBuf>,
    jobs: usize,
    analyzer_path: String,
    tx: mpsc::Sender<AnalysisResult>,
    limits: SizeLimits,
) {
    let pool_config = PoolConfig {
        command: analyzer_path,
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let pool = match ProcessPool::new(pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::error!("Failed to create JS analyzer pool for streaming: {e}");
            return;
        }
    };

    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();

    let mut handles = Vec::with_capacity(total);
    for (idx, file) in files.into_iter().enumerate() {
        let tx = tx.clone();
        let sem = Arc::clone(&semaphore);
        let pool = Arc::clone(&pool);

        handles.push(tokio::spawn(async move {
            let _permit = sem
                .acquire()
                .await
                .expect("Semaphore closed unexpectedly");
            let result = analyze_single_js_file(pool, file, idx, total, limits).await;
            match tx.try_send(result) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(result)) => {
                    BACKPRESSURE_COUNT.fetch_add(1, Ordering::Relaxed);
                    let _ = tx.send(result).await;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => return,
            }
        }));
    }

    // Drop the original sender so the channel closes when all task clones are dropped
    drop(tx);

    for handle in handles {
        let _ = handle.await;
    }

    pool.shutdown().await;
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
    limits: SizeLimits,
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Haskell file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                // Size guard
                if let Some(issue) = check_file_size(&file, limits) {
                    tracing::warn!(file = %file.display(), "Skipping oversized source file: {}", issue.message);
                    return AnalysisResult {
                        file,
                        analysis: None,
                        errors,
                        issues: vec![issue],
                        metrics: FileMetrics {
                            file_size_bytes,
                            ..FileMetrics::default()
                        },
                    };
                }

                // No OXC parsing step — send source directly to haskell-analyzer
                match analyze_haskell_file_pooled(&pool, &file).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
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
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Haskell file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_haskell_file(&file, &bin).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
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
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// BEAM parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple BEAM (Elixir/Erlang) files in parallel using persistent daemon processes.
///
/// Creates a `ProcessPool` with `beam-analyzer --daemon` workers, reads
/// source files from disk, and sends them through the pool. Falls back to
/// `analyze_beam_files_parallel` if pool creation fails.
pub async fn analyze_beam_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
    limits: SizeLimits,
) -> Vec<AnalysisResult> {
    let pool_config = PoolConfig {
        command: analyzers.beam_path(),
        args: vec!["--daemon".to_string()],
        extra_env: crate::config::beam_utf8_env(),
        // A single `.ex`/`.erl` file analyzes in ~300ms (measured single-shot),
        // so the 120s default per-request timeout is far too generous for BEAM —
        // it only ever bites when the daemon is hung. A 30s ceiling keeps a
        // large/pathological file safe while making both the liveness probe
        // below and any per-file timeout fail ~4x faster on a dead daemon.
        request_timeout: std::time::Duration::from_secs(30),
        ..PoolConfig::default()
    };

    let pool = match ProcessPool::new(pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create beam-analyzer pool, falling back to spawn-per-file: {e}"
            );
            return analyze_beam_files_parallel(files, jobs, &analyzers.beam_path()).await;
        }
    };

    let total = files.len();

    // ── Liveness gate (perf/self-analyze) ────────────────────────────────────
    // The parallel fan-out below dispatches every file concurrently, so the
    // pool's request-level circuit breaker cannot help: all requests pass the
    // breaker check at t≈0 (counter still 0) and only time out together at
    // `request_timeout` (120s). A genuinely-non-responsive beam-analyzer daemon
    // (the escript fails to reply on hosts with a broken Elixir/Erlang runtime)
    // therefore costs ~120s × ceil(files/jobs) waves — measured at ~241s for
    // grafema's 25 `.ex` files, the analysis phase's single largest sink.
    //
    // Probe ONE file FIRST, sequentially. A healthy daemon answers in <1s and we
    // fall through to the normal parallel path (file[0] is re-analyzed by the
    // fan-out — one extra sub-second analysis, negligible). A dead daemon fails
    // the probe in one `request_timeout` and we short-circuit ALL files as
    // failed-fast, bounding total damage to a single timeout instead of N. The
    // fan-out loop below is intentionally left untouched (lowest-risk shape).
    if let Err(probe_err) = analyze_beam_file_pooled(&pool, &files[0]).await {
        tracing::error!(
            file = %files[0].display(),
            error = %format!("{probe_err:#}"),
            "beam-analyzer daemon failed its liveness probe — non-responsive; \
             skipping {} remaining BEAM file(s) instead of paying the per-file \
             timeout for each (fix the beam-analyzer daemon: ensure a UTF-8 \
             locale and a working Elixir/Erlang runtime)",
            total.saturating_sub(1)
        );
        let mut out = Vec::with_capacity(total);
        for file in files {
            let file_size_bytes = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
            out.push(AnalysisResult {
                file: file.clone(),
                analysis: None,
                errors: vec![format!(
                    "beam-analyzer daemon non-responsive (liveness probe failed: {probe_err})"
                )],
                issues: vec![],
                metrics: FileMetrics {
                    file_size_bytes,
                    ..FileMetrics::default()
                },
            });
        }
        pool.shutdown().await;
        return out;
    }

    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));

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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing BEAM file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                // Size guard
                if let Some(issue) = check_file_size(&file, limits) {
                    tracing::warn!(file = %file.display(), "Skipping oversized source file: {}", issue.message);
                    return AnalysisResult {
                        file,
                        analysis: None,
                        errors,
                        issues: vec![issue],
                        metrics: FileMetrics {
                            file_size_bytes,
                            ..FileMetrics::default()
                        },
                    };
                }

                // No OXC parsing step — send source directly to beam-analyzer
                match analyze_beam_file_pooled(&pool, &file).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "BEAM analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    errors: vec![format!("BEAM analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    pool.shutdown().await;
    results
}

/// Analyze multiple BEAM (Elixir/Erlang) files in parallel with bounded concurrency (spawn mode).
///
/// For each file:
/// 1. Read source from disk (no OXC parsing — beam-analyzer parses internally)
/// 2. Spawn `beam-analyzer` asynchronously, pipe the source JSON
/// 3. Collect `FileAnalysis` or error
///
/// `jobs` controls the maximum number of concurrent analyses. A tokio
/// `Semaphore` enforces the bound. Failures in individual files do not stop
/// other files from being analyzed.
pub async fn analyze_beam_files_parallel(
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing BEAM file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_beam_file(&file, &bin).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "BEAM analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    errors: vec![format!("BEAM analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
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
    limits: SizeLimits,
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Java file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                // Size guard
                if let Some(issue) = check_file_size(&file, limits) {
                    tracing::warn!(file = %file.display(), "Skipping oversized source file: {}", issue.message);
                    return AnalysisResult {
                        file,
                        analysis: None,
                        errors,
                        issues: vec![issue],
                        metrics: FileMetrics {
                            file_size_bytes,
                            ..FileMetrics::default()
                        },
                    };
                }

                match analyze_java_file_pooled(&parser_pool, &analyzer_pool, &file).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
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
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Java file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_java_file(&file, &analyzers).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
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
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
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
    limits: SizeLimits,
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Kotlin file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                // Size guard
                if let Some(issue) = check_file_size(&file, limits) {
                    tracing::warn!(file = %file.display(), "Skipping oversized source file: {}", issue.message);
                    return AnalysisResult {
                        file,
                        analysis: None,
                        errors,
                        issues: vec![issue],
                        metrics: FileMetrics {
                            file_size_bytes,
                            ..FileMetrics::default()
                        },
                    };
                }

                match analyze_kotlin_file_pooled(&parser_pool, &analyzer_pool, &file).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
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
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Kotlin file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_kotlin_file(&file, &analyzers).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
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
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
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

/// Accessor for RESOLVE_NODE_TYPES (used by main.rs for RFDB queries).
pub fn resolve_node_types() -> &'static [&'static str] {
    RESOLVE_NODE_TYPES
}

/// Convert an RFDB `WireNode` back to the resolver-compatible JSON format
/// (matching the `GraphNode` serialization that resolution plugins expect).
///
/// Key transformations:
/// - `nodeType` → `type`
/// - `semantic_id` → `id` (resolver uses semantic ID strings, not u128 hashes)
/// - metadata string → parsed, `line`/`column`/`endLine`/`endColumn` extracted as top-level fields
pub fn wire_node_to_resolve_json(node: &crate::rfdb::WireNode) -> serde_json::Value {
    let metadata: serde_json::Map<String, serde_json::Value> = node
        .metadata
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let line = metadata.get("line").cloned().unwrap_or(serde_json::json!(0));
    let column = metadata.get("column").cloned().unwrap_or(serde_json::json!(0));
    let end_line = metadata.get("endLine").cloned().unwrap_or(serde_json::json!(0));
    let end_column = metadata.get("endColumn").cloned().unwrap_or(serde_json::json!(0));

    // Build clean metadata (strip position fields — they're now top-level)
    let clean_metadata: serde_json::Map<String, serde_json::Value> = metadata
        .into_iter()
        .filter(|(k, _)| k != "line" && k != "column" && k != "endLine" && k != "endColumn")
        .collect();

    // For resolvers that need to match edges (which use hash IDs), use the
    // hash form as primary `id`. Send `semanticId` separately for resolvers
    // that need to parse semantic IDs (e.g., extracting IMPL_BLOCK type).
    let semantic = node.semantic_id.as_ref().unwrap_or(&node.id);

    serde_json::json!({
        "id": node.id,                  // hash ID — matches edge src/dst
        "semanticId": semantic,          // semantic ID — for path-based extraction
        "type": node.node_type,
        "name": node.name,
        "file": node.file,
        "line": line,
        "column": column,
        "endLine": end_line,
        "endColumn": end_column,
        "exported": node.exported,
        "metadata": clean_metadata,
    })
}

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
    "TYPE_ALIAS",
    "NAMESPACE",
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
    // Swift/Apple types
    "EXTENSION",
    "TYPE_ALIAS",
    "SPM_TARGET",
    "SPM_PACKAGE",
    // Python types
    "UNSAFE_DYNAMIC",
    // BEAM types (REG-1098 W10 — needed by beam-wrapper-resolve and beam-message-findings)
    "MESSAGE_TYPE",
    "PROCESS",
    "PUBSUB_TOPIC",
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                // Log milestones (every 100 files), or every file for small batches
                if total <= 100 || (idx + 1) % 100 == 0 || idx + 1 == total {
                    tracing::info!("[{}/{}] Analyzing {}", idx + 1, total, file_display);
                } else {
                    tracing::debug!("[{}/{}] Analyzing {}", idx + 1, total, file_display);
                }

                let mut errors = Vec::new();

                // Step 1: Parse with OXC (CPU-bound -> spawn_blocking)
                let parse_result = {
                    let file_clone = file.clone();
                    tokio::task::spawn_blocking(move || parser::parse_file(&file_clone)).await
                };

                let parse_ms = file_start.elapsed().as_millis() as u64;

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
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                parse_ms,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                parse_ms,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
                        };
                    }
                };

                // Step 2: Spawn grafema-analyzer
                match analyze_file(&file, &ast_json, &bin).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let analyze_ms = total_ms.saturating_sub(parse_ms);
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms,
                                analyze_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
                    },
                    Err(e) => {
                        errors.push(format!(
                            "Analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                parse_ms,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
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
    limits: SizeLimits,
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!("[{}/{}] Analyzing Python file {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Size guard
                if let Some(issue) = check_file_size(&file, limits) {
                    tracing::warn!(file = %file.display(), "Skipping oversized source file: {}", issue.message);
                    return AnalysisResult {
                        file,
                        analysis: None,
                        errors,
                        issues: vec![issue],
                        metrics: FileMetrics {
                            file_size_bytes,
                            ..FileMetrics::default()
                        },
                    };
                }

                // Step 1: Parse with rustpython-parser (CPU-bound -> spawn_blocking)
                let parse_result = {
                    let file_clone = file.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::python_parser::parse_python_file(&file_clone)
                    }).await
                };

                let parse_ms = file_start.elapsed().as_millis() as u64;

                let ast_json = match parse_result {
                    Ok(Ok(json)) => json,
                    Ok(Err(e)) => {
                        errors.push(format!("Python parse failed for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, parse_ms, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } };
                    }
                    Err(e) => {
                        errors.push(format!("Python parse task panicked for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, parse_ms, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } };
                    }
                };

                // Step 2: Send to daemon pool
                match analyze_python_file_pooled(&pool, &file, &ast_json).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let analyze_ms = total_ms.saturating_sub(parse_ms);
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult { file, analysis: Some(analysis), errors, issues: vec![], metrics: FileMetrics {
                            file_size_bytes, ast_size_bytes: 0, parse_ms, analyze_ms, total_ms, node_count, edge_count,
                            ..Default::default()
                        } }
                    },
                    Err(e) => {
                        errors.push(format!("Python analyzer failed for {file_display}: {e}"));
                        AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, parse_ms, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } }
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!("[{}/{}] Analyzing Python file {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Step 1: Parse with rustpython-parser
                let ast_json = match crate::python_parser::parse_python_file(&file) {
                    Ok(json) => json,
                    Err(e) => {
                        errors.push(format!("Python parse failed for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } };
                    }
                };

                let parse_ms = file_start.elapsed().as_millis() as u64;

                // Step 2: Spawn analyzer
                match analyze_python_file(&file, &ast_json, &bin).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let analyze_ms = total_ms.saturating_sub(parse_ms);
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult { file, analysis: Some(analysis), errors, issues: vec![], metrics: FileMetrics {
                            file_size_bytes, ast_size_bytes: 0, parse_ms, analyze_ms, total_ms, node_count, edge_count,
                            ..Default::default()
                        } }
                    },
                    Err(e) => {
                        errors.push(format!("Python analyzer failed for {file_display}: {e}"));
                        AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, parse_ms, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } }
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
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Go single-file analysis (two-stage: go-parser → go-analyzer)
// ---------------------------------------------------------------------------

/// Analyze a single Go file: parse with go-parser, analyze with go-analyzer.
///
/// Two-stage pipeline:
/// 1. Read source from disk, send to go-parser → receive AST JSON
/// 2. Send AST to go-analyzer → receive FileAnalysis
pub async fn analyze_go_file(
    file: &Path,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Go source file {file_str}"))?;

    // Step 1: Parse with go-parser
    let parser_bin = analyzers.go_parser_path();
    let mut parser_child = tokio::process::Command::new(&parser_bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn go-parser for {file_str}"))?;

    let parser_payload = serde_json::json!({
        "file": file_str,
        "source": source,
    });

    {
        let stdin = parser_child
            .stdin
            .as_mut()
            .context("Failed to open stdin for go-parser")?;
        stdin
            .write_all(parser_payload.to_string().as_bytes())
            .await
            .with_context(|| format!("Failed to write source to go-parser stdin for {file_str}"))?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close go-parser stdin for {file_str}"))?;
    }

    let parser_output = parser_child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for go-parser for {file_str}"))?;

    if !parser_output.status.success() {
        let stderr = String::from_utf8_lossy(&parser_output.stderr);
        let code = parser_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("go-parser exited with code {code} for {file_str}: {stderr}");
    }

    // Extract AST from parser response
    let parser_response: serde_json::Value =
        serde_json::from_slice(&parser_output.stdout).with_context(|| {
            let preview =
                String::from_utf8_lossy(&parser_output.stdout[..parser_output.stdout.len().min(200)]);
            format!("Failed to parse go-parser output for {file_str}: {preview}")
        })?;

    if parser_response.get("status").and_then(|s| s.as_str()) != Some("ok") {
        let err = parser_response
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown error");
        bail!("go-parser error for {file_str}: {err}");
    }

    let ast = parser_response
        .get("ast")
        .with_context(|| format!("go-parser returned ok but no ast for {file_str}"))?;

    // Step 2: Analyze with go-analyzer
    let analyzer_bin = analyzers.go_path();
    let mut analyzer_child = tokio::process::Command::new(&analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn go-analyzer for {file_str}"))?;

    let analyzer_payload = serde_json::json!({
        "file": file_str,
        "ast": ast,
    });

    {
        let stdin = analyzer_child
            .stdin
            .as_mut()
            .context("Failed to open stdin for go-analyzer")?;
        stdin
            .write_all(analyzer_payload.to_string().as_bytes())
            .await
            .with_context(|| {
                format!("Failed to write AST to go-analyzer stdin for {file_str}")
            })?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close go-analyzer stdin for {file_str}"))?;
    }

    let analyzer_output = analyzer_child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for go-analyzer for {file_str}"))?;

    if !analyzer_output.status.success() {
        let stderr = String::from_utf8_lossy(&analyzer_output.stderr);
        let code = analyzer_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("go-analyzer exited with code {code} for {file_str}: {stderr}");
    }

    let analysis: FileAnalysis =
        serde_json::from_slice(&analyzer_output.stdout).with_context(|| {
            let preview = String::from_utf8_lossy(
                &analyzer_output.stdout[..analyzer_output.stdout.len().min(200)],
            );
            format!("Failed to parse go-analyzer output for {file_str}: {preview}")
        })?;

    Ok(analysis)
}

// ---------------------------------------------------------------------------
// Go daemon-mode analysis via ProcessPool (two pools)
// ---------------------------------------------------------------------------

/// Response from go-parser daemon.
/// Uses RawValue for `ast` to avoid parsing + re-serializing the full AST JSON.
#[derive(Deserialize)]
struct GoParserResponse<'a> {
    status: String,
    #[serde(borrow)]
    ast: Option<&'a serde_json::value::RawValue>,
    error: Option<String>,
}

/// Analyze a single Go file via two persistent daemon process pools.
///
/// 1. Read source, send to go-parser pool → receive AST JSON
/// 2. Send AST to go-analyzer pool → receive FileAnalysis
pub async fn analyze_go_file_pooled(
    parser_pool: &ProcessPool,
    analyzer_pool: &ProcessPool,
    file: &Path,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Go source file {file_str}"))?;

    // Step 1: Send to go-parser pool
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
        .with_context(|| format!("Go parser pool request failed for {file_str}"))?;

    // Zero-copy: parse only status/error, borrow raw AST JSON bytes
    let parser_response: GoParserResponse =
        serde_json::from_slice(&parser_response_bytes)
            .with_context(|| format!("Failed to decode go-parser response for {file_str}"))?;

    let ast_raw = match parser_response.status.as_str() {
        "ok" => parser_response
            .ast
            .with_context(|| format!("go-parser returned ok but no ast for {file_str}"))?,
        "error" => {
            let msg = parser_response
                .error
                .unwrap_or_else(|| "unknown error".to_string());
            bail!("go-parser daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown go-parser response status '{other}' for {file_str}"),
    };

    // Step 2: Send to go-analyzer pool (raw AST bytes passed through without re-serialization)
    let analyzer_payload = format!(r#"{{"file":{},"ast":{}}}"#, escaped_file, ast_raw.get());

    let analyzer_response_bytes = analyzer_pool
        .request(analyzer_payload.as_bytes())
        .await
        .with_context(|| format!("Go analyzer pool request failed for {file_str}"))?;

    let response: DaemonResponse = serde_json::from_slice(&analyzer_response_bytes)
        .with_context(|| format!("Failed to decode go-analyzer response for {file_str}"))?;

    match response.status.as_str() {
        "ok" => response
            .result
            .with_context(|| format!("go-analyzer daemon returned ok but no result for {file_str}")),
        "error" => {
            let msg = response.error.unwrap_or_else(|| "unknown error".to_string());
            bail!("go-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown go-analyzer response status '{other}' for {file_str}"),
    }
}

// ---------------------------------------------------------------------------
// Go parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple Go files in parallel using two persistent daemon pools.
///
/// Creates a go-parser pool and a go-analyzer pool. For each file:
/// 1. Read source → send to go-parser pool → receive AST
/// 2. Send AST to go-analyzer pool → receive FileAnalysis
///
/// Falls back to `analyze_go_files_parallel` if pool creation fails.
pub async fn analyze_go_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
    limits: SizeLimits,
) -> Vec<AnalysisResult> {
    let parser_pool_config = PoolConfig {
        command: analyzers.go_parser_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let analyzer_pool_config = PoolConfig {
        command: analyzers.go_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let parser_pool = match ProcessPool::new(parser_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create go-parser pool, falling back to spawn-per-file: {e}"
            );
            return analyze_go_files_parallel(files, jobs, analyzers).await;
        }
    };

    let analyzer_pool = match ProcessPool::new(analyzer_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create go-analyzer pool, falling back to spawn-per-file: {e}"
            );
            parser_pool.shutdown().await;
            return analyze_go_files_parallel(files, jobs, analyzers).await;
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Go file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                // Size guard
                if let Some(issue) = check_file_size(&file, limits) {
                    tracing::warn!(file = %file.display(), "Skipping oversized source file: {}", issue.message);
                    return AnalysisResult {
                        file,
                        analysis: None,
                        errors,
                        issues: vec![issue],
                        metrics: FileMetrics {
                            file_size_bytes,
                            ..FileMetrics::default()
                        },
                    };
                }

                match analyze_go_file_pooled(&parser_pool, &analyzer_pool, &file).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Go analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    errors: vec![format!("Go analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    parser_pool.shutdown().await;
    analyzer_pool.shutdown().await;
    results
}

/// Analyze multiple Go files in parallel with bounded concurrency (spawn mode).
///
/// Fallback when daemon pools cannot be created. Spawns separate processes per file.
pub async fn analyze_go_files_parallel(
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Go file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_go_file(&file, &analyzers).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Go analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    errors: vec![format!("Go analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// C/C++ single-file analysis (in-process parse → cpp-analyzer daemon)
// ---------------------------------------------------------------------------

/// Analyze a single C/C++ file: parse with clang-sys, send AST to cpp-analyzer daemon.
///
/// Pipeline:
/// 1. Parse source with libclang (via `crate::cpp_parser::parse_cpp_file`) -> JSON AST
/// 2. Send `{"file":"...","ast":...}` to grafema-cpp-analyzer -> receive FileAnalysis
pub async fn analyze_cpp_file(
    file: &Path,
    ast_json: &str,
    analyzer_bin: &str,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let mut child = tokio::process::Command::new(analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn grafema-cpp-analyzer for {file_str}"))?;

    let payload = serde_json::json!({
        "file": file_str,
        "ast": serde_json::from_str::<serde_json::Value>(ast_json)
            .unwrap_or(serde_json::Value::Null),
    });

    {
        let stdin = child.stdin.as_mut()
            .context("Failed to open stdin for grafema-cpp-analyzer")?;
        stdin.write_all(payload.to_string().as_bytes()).await
            .with_context(|| format!("Failed to write AST to grafema-cpp-analyzer stdin for {file_str}"))?;
        stdin.shutdown().await
            .with_context(|| format!("Failed to close grafema-cpp-analyzer stdin for {file_str}"))?;
    }

    let output = child.wait_with_output().await
        .with_context(|| format!("Failed to wait for grafema-cpp-analyzer for {file_str}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        anyhow::bail!("grafema-cpp-analyzer exited with code {code} for {file_str}: {stderr}");
    }

    let stdout = &output.stdout;
    let analysis: FileAnalysis = serde_json::from_slice(stdout).with_context(|| {
        let preview = String::from_utf8_lossy(&stdout[..stdout.len().min(200)]);
        format!("Failed to parse grafema-cpp-analyzer output for {file_str}: {preview}")
    })?;

    Ok(analysis)
}

// ---------------------------------------------------------------------------
// Swift single-file analysis (spawn mode)
// ---------------------------------------------------------------------------

/// Analyze a single Swift file: parse with swift-parser, analyze with swift-analyzer.
///
/// Same two-stage pipeline as Kotlin/Go:
/// 1. Read source, send `{"file":"...","source":"..."}` to swift-parser
/// 2. Extract AST from parser response
/// 3. Send `{"file":"...","ast":{...}}` to swift-analyzer
/// 4. Return FileAnalysis
pub async fn analyze_swift_file(
    file: &Path,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    // Step 1: Parse with swift-parser (single-file mode: pass file path as argument)
    let parser_bin = analyzers.swift_parser_path();
    let parser_output = tokio::process::Command::new(&parser_bin)
        .arg(&file_str)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .with_context(|| format!("Failed to run swift-parser for {file_str}"))?;

    if !parser_output.status.success() {
        let stderr = String::from_utf8_lossy(&parser_output.stderr);
        let code = parser_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("swift-parser exited with code {code} for {file_str}: {stderr}");
    }

    let parser_response: serde_json::Value =
        serde_json::from_slice(&parser_output.stdout).with_context(|| {
            let preview =
                String::from_utf8_lossy(&parser_output.stdout[..parser_output.stdout.len().min(200)]);
            format!("Failed to parse swift-parser output for {file_str}: {preview}")
        })?;

    // Single-file mode returns the AST directly ({declarations, imports, file}).
    // Daemon mode wraps it in {status: "ok", ast: {...}}.
    let ast = if let Some(inner) = parser_response.get("ast") {
        // Daemon-style response — check status first
        if parser_response.get("status").and_then(|s| s.as_str()) != Some("ok") {
            let err = parser_response
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("unknown error");
            bail!("swift-parser error for {file_str}: {err}");
        }
        inner.clone()
    } else {
        // Single-file mode: the response IS the AST
        parser_response
    };

    // Step 2: Analyze with swift-analyzer
    let analyzer_bin = analyzers.swift_path();
    let mut analyzer_child = tokio::process::Command::new(&analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn swift-analyzer for {file_str}"))?;

    let analyzer_payload = serde_json::json!({
        "file": file_str,
        "ast": ast,
    });

    {
        let stdin = analyzer_child
            .stdin
            .as_mut()
            .context("Failed to open stdin for swift-analyzer")?;
        stdin
            .write_all(analyzer_payload.to_string().as_bytes())
            .await
            .with_context(|| {
                format!("Failed to write AST to swift-analyzer stdin for {file_str}")
            })?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close swift-analyzer stdin for {file_str}"))?;
    }

    let analyzer_output = analyzer_child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for swift-analyzer for {file_str}"))?;

    if !analyzer_output.status.success() {
        let stderr = String::from_utf8_lossy(&analyzer_output.stderr);
        let code = analyzer_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("swift-analyzer exited with code {code} for {file_str}: {stderr}");
    }

    let analysis: FileAnalysis =
        serde_json::from_slice(&analyzer_output.stdout).with_context(|| {
            let preview = String::from_utf8_lossy(
                &analyzer_output.stdout[..analyzer_output.stdout.len().min(200)],
            );
            format!("Failed to parse swift-analyzer output for {file_str}: {preview}")
        })?;

    Ok(analysis)
}

// ---------------------------------------------------------------------------
// C/C++ daemon-mode analysis via ProcessPool
// ---------------------------------------------------------------------------

/// Analyze a single C/C++ file via a persistent daemon process pool.
pub async fn analyze_cpp_file_pooled(
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
            bail!("grafema-cpp-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown daemon response status '{other}' for {file_str}"),
    }
}

// ---------------------------------------------------------------------------
// Swift daemon-mode analysis via ProcessPool (two pools)
// ---------------------------------------------------------------------------

/// Response from swift-parser daemon.
/// Uses RawValue for `ast` to avoid parsing + re-serializing the full AST JSON.
#[derive(Deserialize)]
struct SwiftParserResponse<'a> {
    status: String,
    #[serde(borrow)]
    ast: Option<&'a serde_json::value::RawValue>,
    error: Option<String>,
}

/// Analyze a single Swift file via two persistent daemon process pools.
///
/// 1. Read source, send to swift-parser pool -> receive AST JSON
/// 2. Send AST to swift-analyzer pool -> receive FileAnalysis
pub async fn analyze_swift_file_pooled(
    parser_pool: &ProcessPool,
    analyzer_pool: &ProcessPool,
    file: &Path,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Swift source file {file_str}"))?;

    // Step 1: Send to swift-parser pool
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
        .with_context(|| format!("Swift parser pool request failed for {file_str}"))?;

    // Zero-copy: parse only status/error, borrow raw AST JSON bytes
    let parser_response: SwiftParserResponse =
        serde_json::from_slice(&parser_response_bytes)
            .with_context(|| format!("Failed to decode swift-parser response for {file_str}"))?;

    let ast_raw = match parser_response.status.as_str() {
        "ok" => parser_response
            .ast
            .with_context(|| format!("swift-parser returned ok but no ast for {file_str}"))?,
        "error" => {
            let msg = parser_response
                .error
                .unwrap_or_else(|| "unknown error".to_string());
            bail!("swift-parser daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown swift-parser response status '{other}' for {file_str}"),
    };

    // Step 2: Send to swift-analyzer pool
    let analyzer_payload = format!(r#"{{"file":{},"ast":{}}}"#, escaped_file, ast_raw.get());

    let analyzer_response_bytes = analyzer_pool
        .request(analyzer_payload.as_bytes())
        .await
        .with_context(|| format!("Swift analyzer pool request failed for {file_str}"))?;

    let response: DaemonResponse = serde_json::from_slice(&analyzer_response_bytes)
        .with_context(|| format!("Failed to decode swift-analyzer response for {file_str}"))?;

    match response.status.as_str() {
        "ok" => response
            .result
            .with_context(|| format!("swift-analyzer daemon returned ok but no result for {file_str}")),
        "error" => {
            let msg = response.error.unwrap_or_else(|| "unknown error".to_string());
            bail!("swift-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown swift-analyzer response status '{other}' for {file_str}"),
    }
}

// ---------------------------------------------------------------------------
// C/C++ parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple C/C++ files in parallel using persistent daemon processes.
///
/// Pipeline per file:
/// 1. Parse with libclang (via `crate::cpp_parser::parse_cpp_file`) -> JSON AST
/// 2. Send AST to grafema-cpp-analyzer daemon pool -> receive FileAnalysis
///
/// Falls back to `analyze_cpp_files_parallel` if pool creation fails.
pub async fn analyze_cpp_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
    compile_commands: Option<&crate::cpp_parser::CompileCommandsDb>,
    limits: SizeLimits,
) -> Vec<AnalysisResult> {
    let pool_config = PoolConfig {
        command: analyzers.cpp_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let pool = match ProcessPool::new(pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create grafema-cpp-analyzer pool, falling back to spawn-per-file: {e}"
            );
            return analyze_cpp_files_parallel(files, jobs, &analyzers.cpp_path(), compile_commands).await;
        }
    };

    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();

    // Pre-compute compile args for each file (CompileCommandsDb is not Send)
    let file_args: Vec<(PathBuf, Vec<String>)> = files.iter().map(|file| {
        let args = compile_commands
            .map(|db| db.get_args(file))
            .unwrap_or_default();
        (file.clone(), args)
    }).collect();

    let handles: Vec<_> = file_args
        .into_iter()
        .enumerate()
        .map(|(idx, (file, extra_args))| {
            let sem = Arc::clone(&semaphore);
            let pool = Arc::clone(&pool);
            let file_display = file.display().to_string();

            tokio::spawn(async move {
                let _permit = sem.acquire().await.expect("Semaphore closed unexpectedly");

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!("[{}/{}] Analyzing C/C++ file {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Size guard
                if let Some(issue) = check_file_size(&file, limits) {
                    tracing::warn!(file = %file.display(), "Skipping oversized source file: {}", issue.message);
                    return AnalysisResult {
                        file,
                        analysis: None,
                        errors,
                        issues: vec![issue],
                        metrics: FileMetrics {
                            file_size_bytes,
                            ..FileMetrics::default()
                        },
                    };
                }

                // Step 1: Parse with libclang (CPU-bound -> spawn_blocking)
                let parse_result = {
                    let file_clone = file.clone();
                    tokio::task::spawn_blocking(move || {
                        // Build default args if no compile_commands
                        let is_c = crate::cpp_parser::is_c_file(&file_clone);
                        let mut args = extra_args;
                        let has_lang_flag = args.iter().any(|a| a.starts_with("-x") || a.starts_with("-std="));
                        if !has_lang_flag {
                            if is_c {
                                args.extend_from_slice(&["-std=c11".to_string(), "-xc".to_string()]);
                            } else {
                                args.extend_from_slice(&["-std=c++17".to_string(), "-xc++".to_string()]);
                            }
                        }

                        let source = std::fs::read_to_string(&file_clone)
                            .with_context(|| format!("Failed to read {}", file_clone.display()))?;
                        let filename = file_clone.display().to_string();
                        let ast = crate::cpp_parser::parse_cpp_source(&source, &filename, &args)?;
                        serde_json::to_string(&ast).context("Failed to serialize C/C++ AST to JSON")
                    }).await
                };

                let parse_ms = file_start.elapsed().as_millis() as u64;

                let ast_json = match parse_result {
                    Ok(Ok(json)) => json,
                    Ok(Err(e)) => {
                        errors.push(format!("C/C++ parse failed for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, parse_ms, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } };
                    }
                    Err(e) => {
                        errors.push(format!("C/C++ parse task panicked for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, parse_ms, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } };
                    }
                };

                // Step 2: Send to daemon pool
                match analyze_cpp_file_pooled(&pool, &file, &ast_json).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let analyze_ms = total_ms.saturating_sub(parse_ms);
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult { file, analysis: Some(analysis), errors, issues: vec![], metrics: FileMetrics {
                            file_size_bytes, ast_size_bytes: 0, parse_ms, analyze_ms, total_ms, node_count, edge_count,
                            ..Default::default()
                        } }
                    },
                    Err(e) => {
                        errors.push(format!("C/C++ analyzer failed for {file_display}: {e}"));
                        AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, parse_ms, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } }
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
                    errors: vec![format!("C/C++ analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    pool.shutdown().await;
    results
}

/// Fallback: analyze C/C++ files in parallel by spawning per-file processes.
pub async fn analyze_cpp_files_parallel(
    files: &[PathBuf],
    jobs: usize,
    analyzer_bin: &str,
    compile_commands: Option<&crate::cpp_parser::CompileCommandsDb>,
) -> Vec<AnalysisResult> {
    let semaphore = Arc::new(Semaphore::new(jobs.max(1)));
    let total = files.len();
    let analyzer_bin = analyzer_bin.to_string();

    // Pre-compute compile args for each file
    let file_args: Vec<(PathBuf, Vec<String>)> = files.iter().map(|file| {
        let args = compile_commands
            .map(|db| db.get_args(file))
            .unwrap_or_default();
        (file.clone(), args)
    }).collect();

    let handles: Vec<_> = file_args
        .into_iter()
        .enumerate()
        .map(|(idx, (file, extra_args))| {
            let sem = Arc::clone(&semaphore);
            let file_display = file.display().to_string();
            let bin = analyzer_bin.clone();

            tokio::spawn(async move {
                let _permit = sem.acquire().await.expect("Semaphore closed unexpectedly");

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!("[{}/{}] Analyzing C/C++ file {}", idx + 1, total, file_display);

                let mut errors = Vec::new();

                // Step 1: Parse with libclang
                let is_c = crate::cpp_parser::is_c_file(&file);
                let mut args = extra_args;
                let has_lang_flag = args.iter().any(|a| a.starts_with("-x") || a.starts_with("-std="));
                if !has_lang_flag {
                    if is_c {
                        args.extend_from_slice(&["-std=c11".to_string(), "-xc".to_string()]);
                    } else {
                        args.extend_from_slice(&["-std=c++17".to_string(), "-xc++".to_string()]);
                    }
                }

                let source = match std::fs::read_to_string(&file) {
                    Ok(s) => s,
                    Err(e) => {
                        errors.push(format!("Failed to read {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } };
                    }
                };

                let ast_value = match crate::cpp_parser::parse_cpp_source(&source, &file_display, &args) {
                    Ok(v) => v,
                    Err(e) => {
                        errors.push(format!("C/C++ parse failed for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } };
                    }
                };

                let ast_json = match serde_json::to_string(&ast_value) {
                    Ok(s) => s,
                    Err(e) => {
                        errors.push(format!("C/C++ AST serialization failed for {file_display}: {e}"));
                        return AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } };
                    }
                };

                let parse_ms = file_start.elapsed().as_millis() as u64;

                // Step 2: Spawn analyzer
                match analyze_cpp_file(&file, &ast_json, &bin).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let analyze_ms = total_ms.saturating_sub(parse_ms);
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult { file, analysis: Some(analysis), errors, issues: vec![], metrics: FileMetrics {
                            file_size_bytes, ast_size_bytes: 0, parse_ms, analyze_ms, total_ms, node_count, edge_count,
                            ..Default::default()
                        } }
                    },
                    Err(e) => {
                        errors.push(format!("C/C++ analyzer failed for {file_display}: {e}"));
                        AnalysisResult { file, analysis: None, errors, issues: vec![], metrics: FileMetrics { file_size_bytes, parse_ms, total_ms: file_start.elapsed().as_millis() as u64, ..FileMetrics::default() } }
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
                    errors: vec![format!("C/C++ analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Swift parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple Swift files in parallel using two persistent daemon pools.
///
/// Falls back to `analyze_swift_files_parallel` if pool creation fails.
pub async fn analyze_swift_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
    limits: SizeLimits,
) -> Vec<AnalysisResult> {
    let parser_pool_config = PoolConfig {
        command: analyzers.swift_parser_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let analyzer_pool_config = PoolConfig {
        command: analyzers.swift_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let parser_pool = match ProcessPool::new(parser_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create swift-parser pool, falling back to spawn-per-file: {e}"
            );
            return analyze_swift_files_parallel(files, jobs, analyzers).await;
        }
    };

    let analyzer_pool = match ProcessPool::new(analyzer_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create swift-analyzer pool, falling back to spawn-per-file: {e}"
            );
            parser_pool.shutdown().await;
            return analyze_swift_files_parallel(files, jobs, analyzers).await;
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Swift file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                // Size guard
                if let Some(issue) = check_file_size(&file, limits) {
                    tracing::warn!(file = %file.display(), "Skipping oversized source file: {}", issue.message);
                    return AnalysisResult {
                        file,
                        analysis: None,
                        errors,
                        issues: vec![issue],
                        metrics: FileMetrics {
                            file_size_bytes,
                            ..FileMetrics::default()
                        },
                    };
                }

                match analyze_swift_file_pooled(&parser_pool, &analyzer_pool, &file).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Swift analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    errors: vec![format!("Swift analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    parser_pool.shutdown().await;
    analyzer_pool.shutdown().await;
    results
}

/// Analyze multiple Swift files in parallel with bounded concurrency (spawn mode).
///
/// Fallback when daemon pools cannot be created.
pub async fn analyze_swift_files_parallel(
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Swift file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_swift_file(&file, &analyzers).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Swift analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    errors: vec![format!("Swift analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Obj-C single-file analysis (spawn mode)
// ---------------------------------------------------------------------------

/// Analyze a single Obj-C file: parse with objc-parser, analyze with objc-analyzer.
///
/// Same two-stage pipeline as Swift/Kotlin/Go:
/// 1. Read source, send `{"file":"...","source":"..."}` to objc-parser
/// 2. Extract AST from parser response
/// 3. Send `{"file":"...","ast":{...}}` to objc-analyzer
/// 4. Return FileAnalysis
pub async fn analyze_objc_file(
    file: &Path,
    analyzers: &crate::config::AnalyzerBinaries,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    // Step 1: Parse with objc-parser (single-file mode: pass file path as argument)
    let parser_bin = analyzers.objc_parser_path();
    let parser_output = tokio::process::Command::new(&parser_bin)
        .arg(&file_str)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .with_context(|| format!("Failed to run objc-parser for {file_str}"))?;

    if !parser_output.status.success() {
        let stderr = String::from_utf8_lossy(&parser_output.stderr);
        let code = parser_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("objc-parser exited with code {code} for {file_str}: {stderr}");
    }

    let parser_response: serde_json::Value =
        serde_json::from_slice(&parser_output.stdout).with_context(|| {
            let preview =
                String::from_utf8_lossy(&parser_output.stdout[..parser_output.stdout.len().min(200)]);
            format!("Failed to parse objc-parser output for {file_str}: {preview}")
        })?;

    // Single-file mode returns {status: "ok", ast: {...}}.
    // Handle both wrapped and direct AST formats for robustness.
    let ast = if let Some(inner) = parser_response.get("ast") {
        if parser_response.get("status").and_then(|s| s.as_str()) != Some("ok") {
            let err = parser_response
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("unknown error");
            bail!("objc-parser error for {file_str}: {err}");
        }
        inner.clone()
    } else {
        parser_response
    };

    // Step 2: Analyze with objc-analyzer
    let analyzer_bin = analyzers.objc_path();
    let mut analyzer_child = tokio::process::Command::new(&analyzer_bin)
        .arg(&file_str)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to spawn objc-analyzer for {file_str}"))?;

    let analyzer_payload = serde_json::json!({
        "file": file_str,
        "ast": ast,
    });

    {
        let stdin = analyzer_child
            .stdin
            .as_mut()
            .context("Failed to open stdin for objc-analyzer")?;
        stdin
            .write_all(analyzer_payload.to_string().as_bytes())
            .await
            .with_context(|| {
                format!("Failed to write AST to objc-analyzer stdin for {file_str}")
            })?;
        stdin
            .shutdown()
            .await
            .with_context(|| format!("Failed to close objc-analyzer stdin for {file_str}"))?;
    }

    let analyzer_output = analyzer_child
        .wait_with_output()
        .await
        .with_context(|| format!("Failed to wait for objc-analyzer for {file_str}"))?;

    if !analyzer_output.status.success() {
        let stderr = String::from_utf8_lossy(&analyzer_output.stderr);
        let code = analyzer_output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        bail!("objc-analyzer exited with code {code} for {file_str}: {stderr}");
    }

    let analysis: FileAnalysis =
        serde_json::from_slice(&analyzer_output.stdout).with_context(|| {
            let preview = String::from_utf8_lossy(
                &analyzer_output.stdout[..analyzer_output.stdout.len().min(200)],
            );
            format!("Failed to parse objc-analyzer output for {file_str}: {preview}")
        })?;

    Ok(analysis)
}

// ---------------------------------------------------------------------------
// Obj-C daemon-mode analysis via ProcessPool (two pools)
// ---------------------------------------------------------------------------

/// Response from objc-parser daemon.
/// Uses RawValue for `ast` to avoid parsing + re-serializing the full AST JSON.
#[derive(Deserialize)]
struct ObjcParserResponse<'a> {
    status: String,
    #[serde(borrow)]
    ast: Option<&'a serde_json::value::RawValue>,
    error: Option<String>,
}

/// Analyze a single Obj-C file via two persistent daemon process pools.
///
/// 1. Read source, send to objc-parser pool -> receive AST JSON
/// 2. Send AST to objc-analyzer pool -> receive FileAnalysis
pub async fn analyze_objc_file_pooled(
    parser_pool: &ProcessPool,
    analyzer_pool: &ProcessPool,
    file: &Path,
) -> Result<FileAnalysis> {
    let file_str = file.display().to_string();

    let source = tokio::fs::read_to_string(file)
        .await
        .with_context(|| format!("Failed to read Obj-C source file {file_str}"))?;

    // Step 1: Send to objc-parser pool
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
        .with_context(|| format!("Obj-C parser pool request failed for {file_str}"))?;

    // Zero-copy: parse only status/error, borrow raw AST JSON bytes
    let parser_response: ObjcParserResponse =
        serde_json::from_slice(&parser_response_bytes)
            .with_context(|| format!("Failed to decode objc-parser response for {file_str}"))?;

    let ast_raw = match parser_response.status.as_str() {
        "ok" => parser_response
            .ast
            .with_context(|| format!("objc-parser returned ok but no ast for {file_str}"))?,
        "error" => {
            let msg = parser_response
                .error
                .unwrap_or_else(|| "unknown error".to_string());
            bail!("objc-parser daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown objc-parser response status '{other}' for {file_str}"),
    };

    // Step 2: Send to objc-analyzer pool
    let analyzer_payload = format!(r#"{{"file":{},"ast":{}}}"#, escaped_file, ast_raw.get());

    let analyzer_response_bytes = analyzer_pool
        .request(analyzer_payload.as_bytes())
        .await
        .with_context(|| format!("Obj-C analyzer pool request failed for {file_str}"))?;

    let response: DaemonResponse = serde_json::from_slice(&analyzer_response_bytes)
        .with_context(|| format!("Failed to decode objc-analyzer response for {file_str}"))?;

    match response.status.as_str() {
        "ok" => response
            .result
            .with_context(|| format!("objc-analyzer daemon returned ok but no result for {file_str}")),
        "error" => {
            let msg = response.error.unwrap_or_else(|| "unknown error".to_string());
            bail!("objc-analyzer daemon error for {file_str}: {msg}")
        }
        other => bail!("Unknown objc-analyzer response status '{other}' for {file_str}"),
    }
}

// ---------------------------------------------------------------------------
// Obj-C parallel multi-file analysis
// ---------------------------------------------------------------------------

/// Analyze multiple Obj-C files in parallel using two persistent daemon pools.
///
/// Falls back to `analyze_objc_files_parallel` if pool creation fails.
pub async fn analyze_objc_files_parallel_pooled(
    files: &[PathBuf],
    jobs: usize,
    analyzers: &crate::config::AnalyzerBinaries,
    limits: SizeLimits,
) -> Vec<AnalysisResult> {
    let parser_pool_config = PoolConfig {
        command: analyzers.objc_parser_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let analyzer_pool_config = PoolConfig {
        command: analyzers.objc_path(),
        args: vec!["--daemon".to_string()],
        ..PoolConfig::default()
    };

    let parser_pool = match ProcessPool::new(parser_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create objc-parser pool, falling back to spawn-per-file: {e}"
            );
            return analyze_objc_files_parallel(files, jobs, analyzers).await;
        }
    };

    let analyzer_pool = match ProcessPool::new(analyzer_pool_config, jobs.max(1)) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            tracing::warn!(
                "Failed to create objc-analyzer pool, falling back to spawn-per-file: {e}"
            );
            parser_pool.shutdown().await;
            return analyze_objc_files_parallel(files, jobs, analyzers).await;
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Obj-C file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                // Size guard
                if let Some(issue) = check_file_size(&file, limits) {
                    tracing::warn!(file = %file.display(), "Skipping oversized source file: {}", issue.message);
                    return AnalysisResult {
                        file,
                        analysis: None,
                        errors,
                        issues: vec![issue],
                        metrics: FileMetrics {
                            file_size_bytes,
                            ..FileMetrics::default()
                        },
                    };
                }

                match analyze_objc_file_pooled(&parser_pool, &analyzer_pool, &file).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Obj-C analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    errors: vec![format!("Obj-C analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    parser_pool.shutdown().await;
    analyzer_pool.shutdown().await;
    results
}

/// Analyze multiple Obj-C files in parallel with bounded concurrency (spawn mode).
///
/// Fallback when daemon pools cannot be created.
pub async fn analyze_objc_files_parallel(
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

                let file_start = std::time::Instant::now();
                let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

                tracing::info!(
                    "[{}/{}] Analyzing Obj-C file {}",
                    idx + 1,
                    total,
                    file_display
                );

                let errors = Vec::new();

                match analyze_objc_file(&file, &analyzers).await {
                    Ok(analysis) => {
                        let total_ms = file_start.elapsed().as_millis() as u64;
                        let node_count = analysis.nodes.len();
                        let edge_count = analysis.edges.len();
                        AnalysisResult {
                            file,
                            analysis: Some(analysis),
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                ast_size_bytes: 0,
                                parse_ms: 0,
                                analyze_ms: total_ms,
                                total_ms,
                                node_count,
                                edge_count,
                                ..Default::default()
                            },
                        }
                    },
                    Err(e) => {
                        let mut errors = errors;
                        errors.push(format!(
                            "Obj-C analyzer failed for {file_display}: {e}"
                        ));
                        AnalysisResult {
                            file,
                            analysis: None,
                            errors,
                            issues: vec![],
                            metrics: FileMetrics {
                                file_size_bytes,
                                total_ms: file_start.elapsed().as_millis() as u64,
                                ..FileMetrics::default()
                            },
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
                    errors: vec![format!("Obj-C analysis task failed: {e}")],
                    issues: vec![],
                    metrics: FileMetrics::default(), // task panicked, no metrics available
                });
            }
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Apple cross-language node collection
// ---------------------------------------------------------------------------

/// Collect resolve nodes from ALL Apple ecosystem languages (Swift + Obj-C).
/// Used by apple-cross-resolve which needs nodes from both languages
/// to resolve cross-language edges (e.g., Swift calling Obj-C bridged APIs).
pub fn collect_resolve_nodes_for_apple(
    results: &[AnalysisResult],
) -> Vec<serde_json::Value> {
    results
        .iter()
        .filter_map(|r| r.analysis.as_ref())
        .filter(|a| {
            matches!(
                crate::config::detect_language(std::path::Path::new(&a.file)),
                Some(crate::config::Language::Swift) | Some(crate::config::Language::ObjectiveC)
            )
        })
        .flat_map(|a| &a.nodes)
        .filter(|n| RESOLVE_NODE_TYPES.contains(&n.node_type.as_str()))
        .filter_map(|n| serde_json::to_value(n).ok())
        .collect()
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
        assert_eq!(analysis.nodes[0].name, "src/app.ts");
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
            issues: vec![],
            metrics: FileMetrics::default(),
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
                issues: vec![],
                metrics: FileMetrics::default(),
            },
            AnalysisResult {
                file: PathBuf::from("fail.js"),
                analysis: None,
                errors: vec!["parse failed".to_string()],
                issues: vec![],
                metrics: FileMetrics::default(),
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
    fn resolve_node_types_include_apple_types() {
        let apple_types = ["EXTENSION", "TYPE_ALIAS"];
        for apple_type in &apple_types {
            assert!(
                RESOLVE_NODE_TYPES.contains(apple_type),
                "RESOLVE_NODE_TYPES should contain {apple_type}"
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
            issues: vec![],
            metrics: FileMetrics::default(),
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
                issues: vec![],
                metrics: FileMetrics::default(),
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
                issues: vec![],
                metrics: FileMetrics::default(),
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
            issues: vec![],
            metrics: FileMetrics::default(),
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
                issues: vec![],
                metrics: FileMetrics::default(),
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
                issues: vec![],
                metrics: FileMetrics::default(),
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
                issues: vec![],
                metrics: FileMetrics::default(),
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
            issues: vec![],
            metrics: FileMetrics::default(),
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

    #[test]
    fn test_encode_fragment() {
        assert_eq!(encode_fragment("FUNCTION->foo"), "FUNCTION-%3Efoo");
        assert_eq!(encode_fragment("CALL->c.log[in:x,h:a3f2]"), "CALL-%3Ec.log%5Bin:x,h:a3f2%5D");
        assert_eq!(encode_fragment("FN->a[in:x,h:ff00]#1"), "FN-%3Ea%5Bin:x,h:ff00%5D%231");
        // Chars that DON'T need encoding
        assert_eq!(encode_fragment("name:with,commas-and.dots"), "name:with,commas-and.dots");
    }

    #[test]
    fn test_compact_to_uri_standard_node() {
        assert_eq!(
            compact_to_uri("src/app.js->FUNCTION->foo", "localhost/grafema"),
            "grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo"
        );
    }

    #[test]
    fn test_compact_to_uri_with_brackets() {
        assert_eq!(
            compact_to_uri("src/app.js->FUNCTION->foo[in:bar]", "localhost/grafema"),
            "grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo%5Bin:bar%5D"
        );
    }

    #[test]
    fn test_compact_to_uri_with_hash_counter() {
        assert_eq!(
            compact_to_uri("src/app.js->FN->a[in:x,h:ff00]#1", "localhost/grafema"),
            "grafema://localhost/grafema/src/app.js#FN-%3Ea%5Bin:x,h:ff00%5D%231"
        );
    }

    #[test]
    fn test_compact_to_uri_call_with_dot_name() {
        assert_eq!(
            compact_to_uri("src/app.js->CALL->c.log[in:x,h:a3f2]", "localhost/grafema"),
            "grafema://localhost/grafema/src/app.js#CALL-%3Ec.log%5Bin:x,h:a3f2%5D"
        );
    }

    #[test]
    fn test_compact_to_uri_module() {
        assert_eq!(
            compact_to_uri("MODULE#src/app.js", "localhost/grafema"),
            "grafema://localhost/grafema/src/app.js#MODULE"
        );
    }

    #[test]
    fn test_compact_to_uri_external_module() {
        assert_eq!(
            compact_to_uri("EXTERNAL_MODULE->lodash", "localhost/grafema"),
            "grafema://localhost/grafema/_/EXTERNAL_MODULE-%3Elodash"
        );
    }

    #[test]
    fn test_compact_to_uri_singleton() {
        assert_eq!(
            compact_to_uri("net:stdio->__stdio__", "localhost/grafema"),
            "grafema://localhost/grafema/_/net:stdio-%3E__stdio__"
        );
    }

    #[test]
    fn test_to_uri_format_rewrites_all_fields() {
        let mut analysis = FileAnalysis {
            file: "src/app.js".to_string(),
            module_id: "MODULE#src/app.js".to_string(),
            nodes: vec![GraphNode {
                id: "src/app.js->FUNCTION->foo".to_string(),
                node_type: "FUNCTION".to_string(),
                name: "foo".to_string(),
                file: "src/app.js".to_string(),
                line: 1,
                column: 0,
                end_line: 10,
                end_column: 1,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            }],
            edges: vec![GraphEdge {
                src: "MODULE#src/app.js".to_string(),
                dst: "src/app.js->FUNCTION->foo".to_string(),
                edge_type: "CONTAINS".to_string(),
                metadata: HashMap::new(),
            }],
            exports: vec![],
        };

        analysis.to_uri_format("localhost/grafema");

        assert_eq!(analysis.module_id, "grafema://localhost/grafema/src/app.js#MODULE");
        assert_eq!(analysis.nodes[0].id, "grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo");
        assert_eq!(analysis.nodes[0].file, "src/app.js"); // file stays as-is
        assert_eq!(analysis.edges[0].src, "grafema://localhost/grafema/src/app.js#MODULE");
        assert_eq!(analysis.edges[0].dst, "grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo");
    }

    // -----------------------------------------------------------------------
    // Size guard tests
    // -----------------------------------------------------------------------

    #[test]
    fn check_file_size_passes_when_under_limit() {
        // Use Cargo.toml as a small test file (well under 1MB)
        let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let limits = SizeLimits { max_file_bytes: 1024 * 1024, max_ast_bytes: 0 };
        assert!(check_file_size(&file, limits).is_none());
    }

    #[test]
    fn check_file_size_skips_when_over_limit() {
        // Use Cargo.toml but with a very low limit (1 byte)
        let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let limits = SizeLimits { max_file_bytes: 1, max_ast_bytes: 0 };
        let issue = check_file_size(&file, limits);
        assert!(issue.is_some());
        let issue = issue.unwrap();
        assert_eq!(issue.category, "oversized_source");
        assert_eq!(issue.severity, "warning");
        assert!(issue.message.contains("Source file too large"));
    }

    #[test]
    fn check_file_size_disabled_when_zero() {
        let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let limits = SizeLimits { max_file_bytes: 0, max_ast_bytes: 0 };
        assert!(check_file_size(&file, limits).is_none());
    }

    #[test]
    fn check_file_size_missing_file_returns_none() {
        let file = PathBuf::from("/nonexistent/file.js");
        let limits = SizeLimits { max_file_bytes: 100, max_ast_bytes: 0 };
        assert!(check_file_size(&file, limits).is_none());
    }

    #[test]
    fn check_ast_size_passes_when_under_limit() {
        let limits = SizeLimits { max_file_bytes: 0, max_ast_bytes: 1024 * 1024 };
        assert!(check_ast_size("test.js", 500, limits).is_none());
    }

    #[test]
    fn check_ast_size_skips_when_over_limit() {
        let limits = SizeLimits { max_file_bytes: 0, max_ast_bytes: 100 };
        let issue = check_ast_size("test.js", 200, limits);
        assert!(issue.is_some());
        let issue = issue.unwrap();
        assert_eq!(issue.category, "oversized_ast");
        assert_eq!(issue.severity, "warning");
        assert!(issue.message.contains("AST too large"));
    }

    #[test]
    fn check_ast_size_disabled_when_zero() {
        let limits = SizeLimits { max_file_bytes: 0, max_ast_bytes: 0 };
        assert!(check_ast_size("test.js", 999_999_999, limits).is_none());
    }

    // -----------------------------------------------------------------------
    // issues_to_wire tests
    // -----------------------------------------------------------------------

    #[test]
    fn issues_to_wire_empty_returns_empty() {
        let (nodes, edges) = issues_to_wire(&[], "src/app.js", "example.com/repo", true);
        assert!(nodes.is_empty());
        assert!(edges.is_empty());
    }

    #[test]
    fn issues_to_wire_with_module_stub() {
        let issues = vec![AnalysisIssue {
            category: "oversized_source".to_string(),
            severity: "warning".to_string(),
            message: "Source file too large: 2048 KB (limit: 1024 KB)".to_string(),
            file: "src/big.js".to_string(),
        }];
        let (nodes, edges) = issues_to_wire(&issues, "src/big.js", "example.com/repo", true);

        // MODULE stub + ISSUE node
        assert_eq!(nodes.len(), 2);
        assert_eq!(edges.len(), 1);

        // MODULE stub
        assert_eq!(nodes[0].node_type.as_deref(), Some("MODULE"));
        assert_eq!(nodes[0].file.as_deref(), Some("src/big.js"));

        // ISSUE node
        assert_eq!(nodes[1].node_type.as_deref(), Some("ISSUE"));
        assert_eq!(nodes[1].file.as_deref(), Some("src/big.js"));
        let meta: HashMap<String, serde_json::Value> =
            serde_json::from_str(nodes[1].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["category"], "oversized_source");
        assert_eq!(meta["severity"], "warning");

        // CONTAINS edge: MODULE → ISSUE
        assert_eq!(edges[0].edge_type, "CONTAINS");
        assert_eq!(edges[0].src, nodes[0].id);
        assert_eq!(edges[0].dst, nodes[1].id);
    }

    #[test]
    fn issues_to_wire_without_module_stub() {
        let issues = vec![AnalysisIssue {
            category: "parse_error".to_string(),
            severity: "error".to_string(),
            message: "Parse failed".to_string(),
            file: "src/bad.js".to_string(),
        }];
        let (nodes, edges) = issues_to_wire(&issues, "src/bad.js", "example.com/repo", false);

        // No MODULE stub, just ISSUE node
        assert_eq!(nodes.len(), 1);
        assert_eq!(edges.len(), 1);
        assert_eq!(nodes[0].node_type.as_deref(), Some("ISSUE"));
    }

    #[test]
    fn issues_to_wire_multiple_issues() {
        let issues = vec![
            AnalysisIssue {
                category: "oversized_source".to_string(),
                severity: "warning".to_string(),
                message: "File too large".to_string(),
                file: "src/huge.js".to_string(),
            },
            AnalysisIssue {
                category: "parse_error".to_string(),
                severity: "error".to_string(),
                message: "Unexpected token".to_string(),
                file: "src/huge.js".to_string(),
            },
        ];
        let (nodes, edges) = issues_to_wire(&issues, "src/huge.js", "example.com/repo", true);

        // MODULE stub + 2 ISSUE nodes
        assert_eq!(nodes.len(), 3);
        // 2 CONTAINS edges
        assert_eq!(edges.len(), 2);
    }

    // -----------------------------------------------------------------------
    // unresolved_diagnostics_to_wire tests
    // -----------------------------------------------------------------------

    #[test]
    fn unresolved_diagnostics_empty_returns_empty() {
        let file_set = HashSet::new();
        let (nodes, edges) = unresolved_diagnostics_to_wire(&[], &file_set, "example.com/repo");
        assert!(nodes.is_empty());
        assert!(edges.is_empty());
    }

    #[test]
    fn unresolved_diagnostics_external_when_file_not_in_set() {
        let file_set: HashSet<String> = ["src/app.ts", "src/utils.ts"]
            .iter().map(|s| s.to_string()).collect();

        let unresolved = vec![(
            "node-1".to_string(),
            "express".to_string(),
            "src/app.ts".to_string(),
        )];

        let (nodes, edges) = unresolved_diagnostics_to_wire(
            &unresolved, &file_set, "example.com/repo",
        );

        // MODULE stub + 1 ISSUE node
        assert_eq!(nodes.len(), 2);
        assert_eq!(edges.len(), 1);

        // MODULE stub
        assert_eq!(nodes[0].node_type.as_deref(), Some("MODULE"));
        assert_eq!(
            nodes[0].file.as_deref(),
            Some("__grafema_virtual/unresolved-diagnostics")
        );

        // ISSUE node — external
        assert_eq!(nodes[1].node_type.as_deref(), Some("ISSUE"));
        let meta: HashMap<String, serde_json::Value> =
            serde_json::from_str(nodes[1].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["category"], "unresolved_external");
        assert_eq!(meta["severity"], "info");
        assert_eq!(meta["symbol_name"], "express");
        assert_eq!(meta["source_file"], "src/app.ts");

        // CONTAINS edge: MODULE → ISSUE
        assert_eq!(edges[0].edge_type, "CONTAINS");
        assert_eq!(edges[0].src, nodes[0].id);
        assert_eq!(edges[0].dst, nodes[1].id);
    }

    #[test]
    fn unresolved_diagnostics_internal_when_file_in_set() {
        let file_set: HashSet<String> = [
            "src/app.ts",
            "src/utils/helper.ts",
        ].iter().map(|s| s.to_string()).collect();

        let unresolved = vec![(
            "node-2".to_string(),
            "./utils/helper".to_string(),
            "src/app.ts".to_string(),
        )];

        let (nodes, _edges) = unresolved_diagnostics_to_wire(
            &unresolved, &file_set, "example.com/repo",
        );

        // MODULE stub + 1 ISSUE node
        assert_eq!(nodes.len(), 2);

        let meta: HashMap<String, serde_json::Value> =
            serde_json::from_str(nodes[1].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["category"], "unresolved_internal");
        assert_eq!(meta["severity"], "warning");
    }

    #[test]
    fn unresolved_diagnostics_multiple_mixed() {
        let file_set: HashSet<String> = [
            "src/app.ts",
            "src/billing/endpoint.ts",
        ].iter().map(|s| s.to_string()).collect();

        let unresolved = vec![
            (
                "node-a".to_string(),
                "lodash".to_string(),
                "src/app.ts".to_string(),
            ),
            (
                "node-b".to_string(),
                "./billing/endpoint".to_string(),
                "src/app.ts".to_string(),
            ),
        ];

        let (nodes, edges) = unresolved_diagnostics_to_wire(
            &unresolved, &file_set, "example.com/repo",
        );

        // MODULE stub + 2 ISSUE nodes
        assert_eq!(nodes.len(), 3);
        // 2 CONTAINS edges
        assert_eq!(edges.len(), 2);

        // First: external (lodash not in file_set)
        let meta0: HashMap<String, serde_json::Value> =
            serde_json::from_str(nodes[1].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta0["category"], "unresolved_external");

        // Second: internal (billing/endpoint matches a file in set)
        let meta1: HashMap<String, serde_json::Value> =
            serde_json::from_str(nodes[2].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta1["category"], "unresolved_internal");
    }

    #[test]
    fn unresolved_diagnostics_uri_format() {
        let file_set = HashSet::new();
        let unresolved = vec![(
            "node-1".to_string(),
            "foo".to_string(),
            "src/bar.ts".to_string(),
        )];

        let (nodes, _) = unresolved_diagnostics_to_wire(
            &unresolved, &file_set, "example.com/repo",
        );

        // All IDs should be grafema:// URIs
        for node in &nodes {
            assert!(
                node.id.starts_with("grafema://example.com/repo/"),
                "Expected grafema URI, got: {}",
                node.id
            );
        }
    }

    // -----------------------------------------------------------------------
    // metrics_to_wire tests
    // -----------------------------------------------------------------------

    #[test]
    fn metrics_to_wire_default_returns_empty() {
        let metrics = FileMetrics::default();
        let (nodes, edges) = metrics_to_wire(&metrics, "src/app.js", "example.com/repo");
        assert!(nodes.is_empty());
        assert!(edges.is_empty());
    }

    #[test]
    fn metrics_to_wire_skips_zero_values() {
        let metrics = FileMetrics {
            parse_ms: 42,
            analyze_ms: 0,
            total_ms: 0,
            file_size_bytes: 0,
            ast_size_bytes: 0,
            node_count: 0,
            edge_count: 0,
            ..Default::default()
        };
        let (nodes, edges) = metrics_to_wire(&metrics, "src/app.js", "example.com/repo");
        assert_eq!(nodes.len(), 1);
        assert_eq!(edges.len(), 1);
        assert_eq!(nodes[0].name.as_deref(), Some("parse_ms"));
    }

    #[test]
    fn metrics_to_wire_all_fields() {
        let metrics = FileMetrics {
            parse_ms: 10,
            analyze_ms: 20,
            total_ms: 30,
            file_size_bytes: 1024,
            ast_size_bytes: 2048,
            node_count: 5,
            edge_count: 3,
            ..Default::default()
        };
        let (nodes, edges) = metrics_to_wire(&metrics, "src/app.js", "example.com/repo");

        // 7 non-zero metrics → 7 nodes + 7 OBSERVES edges
        assert_eq!(nodes.len(), 7);
        assert_eq!(edges.len(), 7);

        // All nodes are METRIC type
        for node in &nodes {
            assert_eq!(node.node_type.as_deref(), Some("METRIC"));
            assert_eq!(node.file.as_deref(), Some("src/app.js"));
        }

        // All edges are OBSERVES pointing to MODULE
        let module_id = compact_to_uri("MODULE#src/app.js", "example.com/repo");
        for edge in &edges {
            assert_eq!(edge.edge_type, "OBSERVES");
            assert_eq!(edge.dst, module_id);
        }

        // Check first metric metadata
        let meta: HashMap<String, serde_json::Value> =
            serde_json::from_str(nodes[0].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["value"], 10);
        assert_eq!(meta["unit"], "ms");
        assert_eq!(meta["source"], "orchestrator");
    }

    #[test]
    fn metrics_to_wire_uri_format() {
        let metrics = FileMetrics {
            total_ms: 100,
            ..Default::default()
        };
        let (nodes, _) = metrics_to_wire(&metrics, "src/app.js", "example.com/repo");
        assert_eq!(nodes.len(), 1);
        // ID should be a grafema:// URI
        assert!(nodes[0].id.starts_with("grafema://example.com/repo/src/app.js#"));
    }

    // -----------------------------------------------------------------------
    // phase_metrics_to_wire tests
    // -----------------------------------------------------------------------

    #[test]
    fn phase_metrics_to_wire_empty() {
        let (nodes, edges) = phase_metrics_to_wire(&[], "example.com/repo");
        assert!(nodes.is_empty());
        assert!(edges.is_empty());
    }

    #[test]
    fn phase_metrics_to_wire_skips_zero() {
        let metrics = vec![
            ("analysis", "duration_ms", 0u64, "ms"),
            ("analysis", "total_nodes", 500u64, "count"),
        ];
        let (nodes, edges) = phase_metrics_to_wire(&metrics, "example.com/repo");
        assert_eq!(nodes.len(), 1);
        assert!(edges.is_empty());
        assert_eq!(nodes[0].name.as_deref(), Some("total_nodes"));
    }

    #[test]
    fn phase_metrics_to_wire_synthetic_file() {
        let metrics = vec![
            ("analysis", "duration_ms", 5000u64, "ms"),
            ("compact", "duration_ms", 200u64, "ms"),
        ];
        let (nodes, _) = phase_metrics_to_wire(&metrics, "example.com/repo");
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].file.as_deref(), Some("__grafema_perf/analysis"));
        assert_eq!(nodes[1].file.as_deref(), Some("__grafema_perf/compact"));

        // Check phase metadata
        let meta: HashMap<String, serde_json::Value> =
            serde_json::from_str(nodes[0].metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["phase"], "analysis");
        assert_eq!(meta["value"], 5000);
        assert_eq!(meta["unit"], "ms");
    }

    // profile_subgraph_to_wire tests

    fn sample_stages() -> Vec<ProfileStage> {
        vec![
            ProfileStage { phase: "resolve", kind: "resolver", name: "js_resolve".into(), wall_ms: 11000, edges_produced: 5000, nodes_produced: 100, order: 10 },
            ProfileStage { phase: "resolve", kind: "resolver", name: "rust-cross-method-calls".into(), wall_ms: 52000, edges_produced: 3000, nodes_produced: 0, order: 20 },
            ProfileStage { phase: "derive", kind: "derive_pack", name: "@stdlib/depends".into(), wall_ms: 8000, edges_produced: 4000, nodes_produced: 0, order: 30 },
            // a DEAD stage: high wall, zero edges
            ProfileStage { phase: "derive", kind: "derive_pack", name: "@stdlib/type_inference".into(), wall_ms: 72000, edges_produced: 0, nodes_produced: 0, order: 40 },
        ]
    }

    #[test]
    fn profile_subgraph_emits_run_phase_stage_metric() {
        let run = ProfileRunSummary { total_ms: 143000, ts: "2026-06-19T12:00:00Z".into() };
        let (nodes, edges) = profile_subgraph_to_wire(&run, &sample_stages(), "example.com/repo");

        let count_type = |t: &str| nodes.iter().filter(|n| n.node_type.as_deref() == Some(t)).count();
        assert_eq!(count_type("profile:run"), 1);
        assert_eq!(count_type("profile:phase"), 2, "resolve + derive phases");
        assert_eq!(count_type("profile:stage"), 4);
        // 3 stage METRICs each (wall_ms/edges_produced/nodes_produced) + 1 per-phase wall_ms.
        assert_eq!(count_type("METRIC"), 4 * 3 + 2);

        let edge_count = |t: &str| edges.iter().filter(|e| e.edge_type == t).count();
        // PART_OF: 2 phases->run + 4 stages->phase
        assert_eq!(edge_count("PART_OF"), 6);
        // OBSERVES: one per METRIC
        assert_eq!(edge_count("OBSERVES"), 4 * 3 + 2);
        // PRECEDES: 1 within resolve (2 stages) + 1 within derive (2 stages)
        assert_eq!(edge_count("PRECEDES"), 2);
    }

    #[test]
    fn profile_subgraph_stage_metadata_has_dead_signal() {
        let run = ProfileRunSummary { total_ms: 1000, ts: "2026-06-19T12:00:00Z".into() };
        let (nodes, _) = profile_subgraph_to_wire(&run, &sample_stages(), "example.com/repo");
        let dead = nodes.iter().find(|n| n.name.as_deref() == Some("@stdlib/type_inference")).unwrap();
        let meta: HashMap<String, serde_json::Value> =
            serde_json::from_str(dead.metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["wall_ms"], 72000);
        assert_eq!(meta["edges_produced"], 0);
        assert_eq!(meta["kind"], "derive_pack");
        assert_eq!(meta["phase"], "derive");
    }

    #[test]
    fn profile_subgraph_empty_stages_still_emits_run() {
        let run = ProfileRunSummary { total_ms: 100, ts: "2026-06-19T12:00:00Z".into() };
        let (nodes, edges) = profile_subgraph_to_wire(&run, &[], "example.com/repo");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].node_type.as_deref(), Some("profile:run"));
        assert!(edges.is_empty());
    }

    #[test]
    fn size_limits_from_config_converts_kb_to_bytes() {
        let cfg = crate::config::AnalyzerConfig {
            root: PathBuf::from("."),
            include: vec![],
            exclude: vec![],
            plugins: vec![],
            rfdb_socket: None,
            analyzers: Default::default(),
            services: vec![],
            authority: None,
            aliases: Default::default(),
            max_file_size_kb: 512,
            max_ast_size_kb: 2048,
        };
        let limits = SizeLimits::from_config(&cfg);
        assert_eq!(limits.max_file_bytes, 512 * 1024);
        assert_eq!(limits.max_ast_bytes, 2048 * 1024);
    }

    #[test]
    fn size_limits_zero_means_unlimited() {
        let cfg = crate::config::AnalyzerConfig {
            root: PathBuf::from("."),
            include: vec![],
            exclude: vec![],
            plugins: vec![],
            rfdb_socket: None,
            analyzers: Default::default(),
            services: vec![],
            authority: None,
            aliases: Default::default(),
            max_file_size_kb: 0,
            max_ast_size_kb: 0,
        };
        let limits = SizeLimits::from_config(&cfg);
        assert_eq!(limits.max_file_bytes, 0);
        assert_eq!(limits.max_ast_bytes, 0);
    }

    // -----------------------------------------------------------------------
    // Byte-offset → line:column conversion tests
    // -----------------------------------------------------------------------

    #[test]
    fn build_line_index_empty() {
        let idx = build_line_index(b"");
        assert_eq!(idx, vec![0]);
    }

    #[test]
    fn build_line_index_single_line() {
        let idx = build_line_index(b"hello");
        assert_eq!(idx, vec![0]);
    }

    #[test]
    fn build_line_index_multiple_lines() {
        // "ab\ncd\nef"
        // Line 1: bytes 0..2 ("ab")
        // Line 2: bytes 3..4 ("cd")
        // Line 3: bytes 6..7 ("ef")
        let idx = build_line_index(b"ab\ncd\nef");
        assert_eq!(idx, vec![0, 3, 6]);
    }

    #[test]
    fn build_line_index_trailing_newline() {
        let idx = build_line_index(b"ab\n");
        assert_eq!(idx, vec![0, 3]);
    }

    #[test]
    fn byte_offset_to_line_col_start_of_file() {
        let idx = build_line_index(b"ab\ncd\nef");
        // Offset 0 = start of line 1
        assert_eq!(byte_offset_to_line_col(&idx, 0), (1, 0));
    }

    #[test]
    fn byte_offset_to_line_col_middle_of_first_line() {
        let idx = build_line_index(b"abcdef\ngh");
        // Offset 3 = 4th byte on line 1, column 3
        assert_eq!(byte_offset_to_line_col(&idx, 3), (1, 3));
    }

    #[test]
    fn byte_offset_to_line_col_start_of_second_line() {
        let idx = build_line_index(b"ab\ncd\nef");
        // Offset 3 = start of line 2
        assert_eq!(byte_offset_to_line_col(&idx, 3), (2, 0));
    }

    #[test]
    fn byte_offset_to_line_col_middle_of_second_line() {
        let idx = build_line_index(b"ab\ncd\nef");
        // Offset 4 = "d" on line 2, column 1
        assert_eq!(byte_offset_to_line_col(&idx, 4), (2, 1));
    }

    #[test]
    fn byte_offset_to_line_col_start_of_third_line() {
        let idx = build_line_index(b"ab\ncd\nef");
        // Offset 6 = start of line 3
        assert_eq!(byte_offset_to_line_col(&idx, 6), (3, 0));
    }

    #[test]
    fn byte_offset_to_line_col_beyond_eof() {
        let idx = build_line_index(b"ab\ncd");
        // Offset 100 = beyond end of file, should land on last line
        let (line, col) = byte_offset_to_line_col(&idx, 100);
        assert_eq!(line, 2);
        assert_eq!(col, 97); // 100 - 3 (start of line 2)
    }

    #[test]
    fn byte_offset_to_line_col_at_newline_char() {
        let idx = build_line_index(b"ab\ncd\nef");
        // Offset 2 = the '\n' character on line 1, column 2
        assert_eq!(byte_offset_to_line_col(&idx, 2), (1, 2));
    }

    #[test]
    fn is_js_ts_file_js_extensions() {
        for ext in &["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"] {
            let path = PathBuf::from(format!("src/app.{ext}"));
            assert!(is_js_ts_file(&path), "expected true for .{ext}");
        }
    }

    #[test]
    fn is_js_ts_file_non_js_extensions() {
        for ext in &["rs", "py", "hs", "java", "go", "cpp"] {
            let path = PathBuf::from(format!("src/app.{ext}"));
            assert!(!is_js_ts_file(&path), "expected false for .{ext}");
        }
    }

    #[test]
    fn convert_byte_offsets_to_lines_with_real_file() {
        use std::io::Write;
        // Create a temporary file with known content
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.js");
        {
            let mut f = std::fs::File::create(&file_path).unwrap();
            // Line 1: "const x = 1;\n"   (13 bytes: 0..12, newline at 12)
            // Line 2: "const y = 2;\n"   (13 bytes: 13..25, newline at 25)
            // Line 3: "function foo() {\n" (17 bytes: 26..42, newline at 42)
            // line_index = [0, 13, 26, 43]
            write!(f, "const x = 1;\nconst y = 2;\nfunction foo() {{\n").unwrap();
        }

        let mut analysis = FileAnalysis {
            file: file_path.display().to_string(),
            module_id: file_path.display().to_string(),
            nodes: vec![
                GraphNode {
                    id: "test.js->VARIABLE->x".to_string(),
                    node_type: "VARIABLE".to_string(),
                    name: "x".to_string(),
                    file: file_path.display().to_string(),
                    line: 6,    // byte offset of 'x' in "const x"
                    column: 0,
                    end_line: 12, // byte offset of '\n' at end of line 1
                    end_column: 0,
                    exported: false,
                    metadata: HashMap::new(),
                    extra: HashMap::new(),
                },
                GraphNode {
                    id: "test.js->FUNCTION->foo".to_string(),
                    node_type: "FUNCTION".to_string(),
                    name: "foo".to_string(),
                    file: file_path.display().to_string(),
                    line: 26,   // byte offset of "function" on line 3
                    column: 0,
                    end_line: 42, // byte offset of '\n' at end of line 3
                    end_column: 0,
                    exported: false,
                    metadata: HashMap::new(),
                    extra: HashMap::new(),
                },
            ],
            edges: vec![],
            exports: vec![],
        };

        analysis.convert_byte_offsets_to_lines(&file_path);

        // Node 0: byte 6 → line 1, col 6; byte 12 → line 1, col 12
        assert_eq!(analysis.nodes[0].line, 1);
        assert_eq!(analysis.nodes[0].column, 6);
        assert_eq!(analysis.nodes[0].end_line, 1);
        assert_eq!(analysis.nodes[0].end_column, 12);

        // Node 1: byte 26 → line 3, col 0; byte 42 → line 3, col 16
        assert_eq!(analysis.nodes[1].line, 3);
        assert_eq!(analysis.nodes[1].column, 0);
        assert_eq!(analysis.nodes[1].end_line, 3);
        assert_eq!(analysis.nodes[1].end_column, 16);
    }

    #[test]
    fn convert_byte_offsets_skips_zero_positions() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.js");
        {
            let mut f = std::fs::File::create(&file_path).unwrap();
            write!(f, "const x = 1;\n").unwrap();
        }

        let mut analysis = FileAnalysis {
            file: file_path.display().to_string(),
            module_id: file_path.display().to_string(),
            nodes: vec![GraphNode {
                id: "test.js->MODULE".to_string(),
                node_type: "MODULE".to_string(),
                name: "test.js".to_string(),
                file: file_path.display().to_string(),
                line: 0,     // 0 means "no position" — should NOT be converted
                column: 0,
                end_line: 0,
                end_column: 0,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            }],
            edges: vec![],
            exports: vec![],
        };

        analysis.convert_byte_offsets_to_lines(&file_path);

        // Zero positions should remain unchanged
        assert_eq!(analysis.nodes[0].line, 0);
        assert_eq!(analysis.nodes[0].column, 0);
        assert_eq!(analysis.nodes[0].end_line, 0);
        assert_eq!(analysis.nodes[0].end_column, 0);
    }

    #[test]
    fn convert_byte_offsets_missing_file_is_noop() {
        let missing_path = PathBuf::from("/nonexistent/file.js");
        let mut analysis = FileAnalysis {
            file: missing_path.display().to_string(),
            module_id: missing_path.display().to_string(),
            nodes: vec![GraphNode {
                id: "file.js->FUNCTION->foo".to_string(),
                node_type: "FUNCTION".to_string(),
                name: "foo".to_string(),
                file: missing_path.display().to_string(),
                line: 100,
                column: 0,
                end_line: 200,
                end_column: 0,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            }],
            edges: vec![],
            exports: vec![],
        };

        analysis.convert_byte_offsets_to_lines(&missing_path);

        // Should be unchanged — file couldn't be read
        assert_eq!(analysis.nodes[0].line, 100);
        assert_eq!(analysis.nodes[0].end_line, 200);
    }

    // ── workspace_packages_to_wire (Wave 3c) ────────────────────────────────

    fn ws_pkg(name: &str, entry: &str, dir: &str) -> crate::plugin::WorkspacePackageWire {
        crate::plugin::WorkspacePackageWire {
            name: name.to_string(),
            entry_point: entry.to_string(),
            package_dir: dir.to_string(),
        }
    }

    #[test]
    fn workspace_packages_to_wire_emits_fact_shape() {
        let pkgs = vec![ws_pkg(
            "@grafema/util",
            "packages/util/src/index.ts",
            "packages/util",
        )];
        let nodes = workspace_packages_to_wire(&pkgs, "github.com/o/r");
        assert_eq!(nodes.len(), 1);
        let n = &nodes[0];
        // The pack joins attr(W,"name") × attr(W,"file") — both first-class.
        assert_eq!(n.node_type.as_deref(), Some("WORKSPACE_PACKAGE"));
        assert_eq!(n.name.as_deref(), Some("@grafema/util"));
        assert_eq!(n.file.as_deref(), Some("packages/util/src/index.ts"));
        assert!(!n.exported);
        // package_dir rides in metadata (synthesis §4 item 3 convention).
        let meta: serde_json::Value =
            serde_json::from_str(n.metadata.as_deref().unwrap()).unwrap();
        assert_eq!(meta["package_dir"], "packages/util");
        // file->TYPE->name semantic-id shape under the authority URI.
        assert!(
            n.id.starts_with("grafema://github.com/o/r/packages/util/src/index.ts#"),
            "uri id keeps the file prefix: {}",
            n.id
        );
        assert!(n.id.contains("WORKSPACE_PACKAGE"), "typed id: {}", n.id);
        assert_eq!(n.semantic_id.as_deref(), Some(n.id.as_str()));
    }

    #[test]
    fn workspace_packages_to_wire_is_stable_across_runs_and_covers_aliases() {
        // Alias-expanded virtual packages (main.rs) use the same wire type —
        // they must become facts too (the legacy wsMap included them).
        let pkgs = vec![
            ws_pkg("@grafema/util", "packages/util/src/index.ts", "packages/util"),
            ws_pkg("jodit/esm", "jodit/src/index.ts", "jodit/src"),
        ];
        let a = workspace_packages_to_wire(&pkgs, "github.com/o/r");
        let b = workspace_packages_to_wire(&pkgs, "github.com/o/r");
        assert_eq!(a.len(), 2);
        // Same input ⇒ byte-identical ids (stable across runs — upsert dedups).
        let ids_a: Vec<&str> = a.iter().map(|n| n.id.as_str()).collect();
        let ids_b: Vec<&str> = b.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids_a, ids_b);
        // Distinct packages get distinct ids.
        assert_ne!(ids_a[0], ids_a[1]);
        assert_eq!(b[1].name.as_deref(), Some("jodit/esm"));
    }

    #[test]
    fn workspace_packages_to_wire_empty_is_empty() {
        assert!(workspace_packages_to_wire(&[], "github.com/o/r").is_empty());
    }

    /// The GO module-path fact (P1): the go packs join
    /// `node_attr(W, "language", "go")` × `attr(W, "name", MP)` — the language
    /// discriminator MUST ride metadata and the module path MUST be the
    /// first-class name; ids stable across runs (upsert dedups).
    #[test]
    fn go_module_workspace_fact_shape_and_stability() {
        let a = go_module_workspace_fact("github.com/user/project", ".", "github.com/o/r");
        assert_eq!(a.node_type.as_deref(), Some("WORKSPACE_PACKAGE"));
        assert_eq!(a.name.as_deref(), Some("github.com/user/project"));
        assert_eq!(a.file.as_deref(), Some("go.mod"));
        assert!(!a.exported);
        let meta: serde_json::Value =
            serde_json::from_str(a.metadata.as_deref().unwrap()).unwrap();
        assert_eq!(meta["language"], "go", "the go packs' discriminator key");
        assert_eq!(meta["package_dir"], ".");
        let b = go_module_workspace_fact("github.com/user/project", ".", "github.com/o/r");
        assert_eq!(a.id, b.id, "stable id across runs");
        assert_eq!(a.semantic_id.as_deref(), Some(a.id.as_str()));
        assert!(a.id.contains("WORKSPACE_PACKAGE"), "typed id: {}", a.id);
    }
}
