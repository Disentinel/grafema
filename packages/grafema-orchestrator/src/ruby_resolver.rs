//! Ruby cross-file resolution — resolves require/require_relative/include/extend/prepend.

use crate::rfdb::{RfdbClient, WireNode, WireEdge};
use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;

/// Output from the Ruby resolver (nodes + edges to commit).
#[derive(Default)]
pub struct ResolveOutput {
    pub nodes: Vec<WireNode>,
    pub edges: Vec<WireEdge>,
}

/// Resolve Ruby imports across files.
///
/// Algorithm:
/// 1. Query RFDB for all Ruby MODULE and IMPORT nodes
/// 2. Build indexes: file_stem → module_id, constant_name → module_ids
/// 3. For each IMPORT, resolve by kind (require / require_relative / include / extend / prepend)
pub async fn resolve_ruby_imports(
    rfdb: &mut RfdbClient,
    _root: &str,
) -> Result<ResolveOutput> {
    // 1. Query all MODULE nodes for Ruby files
    let all_modules = rfdb.query_nodes_by_type("MODULE").await?;
    let ruby_modules: Vec<_> = all_modules
        .iter()
        .filter(|n| {
            n.file
                .as_deref()
                .map(|f| f.ends_with(".rb") || f.ends_with(".rake") || f.ends_with(".gemspec"))
                .unwrap_or(false)
        })
        .collect();

    if ruby_modules.is_empty() {
        return Ok(ResolveOutput::default());
    }

    // 2. Query all IMPORT nodes for Ruby files
    let all_imports = rfdb.query_nodes_by_type("IMPORT").await?;
    let ruby_imports: Vec<_> = all_imports
        .iter()
        .filter(|n| {
            n.file
                .as_deref()
                .map(|f| f.ends_with(".rb") || f.ends_with(".rake") || f.ends_with(".gemspec"))
                .unwrap_or(false)
        })
        .collect();

    // 3. Build indexes
    // file_path → module_id (for require resolution)
    let mut file_to_module: HashMap<String, String> = HashMap::new();
    // file_stem (without .rb) → file_paths (for require matching)
    let mut stem_to_file: HashMap<String, Vec<String>> = HashMap::new();
    // constant_name → module_ids (for include/extend/prepend)
    let mut constant_to_modules: HashMap<String, Vec<String>> = HashMap::new();

    for module in &ruby_modules {
        if let Some(file) = &module.file {
            file_to_module.insert(file.clone(), module.id.clone());

            // Build stem index: "lib/foo/bar.rb" → stems ["lib/foo/bar", "foo/bar", "bar"]
            let path = Path::new(file);
            let stem = path.with_extension("");
            let stem_str = stem.to_string_lossy().to_string();
            stem_to_file
                .entry(stem_str.clone())
                .or_default()
                .push(file.clone());

            // Also index progressively shorter suffixes
            let parts: Vec<&str> = stem_str.split('/').collect();
            for i in 1..parts.len() {
                let suffix = parts[i..].join("/");
                stem_to_file
                    .entry(suffix)
                    .or_default()
                    .push(file.clone());
            }
        }

        // Index by constant name (from MODULE nodes that represent `module Foo` / `class Foo`)
        // File-level modules have filename-like names with dots/slashes — skip those.
        if let Some(name) = &module.name {
            if !name.contains('.') && !name.contains('/') {
                constant_to_modules
                    .entry(name.clone())
                    .or_default()
                    .push(module.id.clone());
            }
        }
    }

    // 4. Resolve each import
    let mut edges: Vec<WireEdge> = Vec::new();

    for import in &ruby_imports {
        let metadata: HashMap<String, serde_json::Value> = import
            .metadata
            .as_deref()
            .and_then(|m| serde_json::from_str(m).ok())
            .unwrap_or_default();

        let kind = metadata
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("require");
        let source = metadata
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if source.is_empty() {
            continue;
        }

        match kind {
            "require" => {
                // Match source against stem index
                if let Some(files) = stem_to_file.get(source) {
                    if let Some(target_file) = files.first() {
                        if let Some(target_module) = file_to_module.get(target_file) {
                            edges.push(WireEdge {
                                src: import.id.clone(),
                                dst: target_module.clone(),
                                edge_type: "IMPORTS_FROM".to_string(),
                                metadata: Some(
                                    serde_json::json!({"resolvedVia": "require"}).to_string(),
                                ),
                            });
                        }
                    }
                }
            }
            "require_relative" => {
                // Resolve relative to current file's directory
                if let Some(import_file) = &import.file {
                    let import_dir = Path::new(import_file)
                        .parent()
                        .unwrap_or(Path::new(""));
                    let mut target = import_dir.join(source);
                    // Append .rb if no extension present
                    if target.extension().is_none() {
                        target.set_extension("rb");
                    }
                    let target_str = target.to_string_lossy().to_string();
                    let normalized = normalize_path(&target_str);
                    if let Some(target_module) = file_to_module.get(&normalized) {
                        edges.push(WireEdge {
                            src: import.id.clone(),
                            dst: target_module.clone(),
                            edge_type: "IMPORTS_FROM".to_string(),
                            metadata: Some(
                                serde_json::json!({"resolvedVia": "require_relative"}).to_string(),
                            ),
                        });
                    }
                }
            }
            "include" | "extend" | "prepend" => {
                // Resolve by constant name
                if let Some(target_modules) = constant_to_modules.get(source) {
                    for target_id in target_modules {
                        edges.push(WireEdge {
                            src: import.id.clone(),
                            dst: target_id.clone(),
                            edge_type: "IMPORTS_FROM".to_string(),
                            metadata: Some(
                                serde_json::json!({
                                    "resolvedVia": kind,
                                    "mixinKind": kind
                                })
                                .to_string(),
                            ),
                        });
                    }
                }
            }
            _ => {}
        }
    }

    let edge_count = edges.len();
    tracing::info!(resolved = edge_count, "Ruby resolution complete");

    Ok(ResolveOutput {
        nodes: vec![],
        edges,
    })
}

/// Simple path normalization — resolve `..` and `.` components.
fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            _ => parts.push(part),
        }
    }
    parts.join("/")
}
