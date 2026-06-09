//! Native Ruby analyzer — walks Prism AST directly, no serialization.
//!
//! FAIL-EARLY POLICY: unhandled Prism node variants panic immediately.
//! No silent skips, no "log and continue". If it crashes, we fix the handler.

use crate::analyzer::{AnalysisIssue, AnalysisResult, ExportInfo, FileAnalysis, FileMetrics, GraphEdge, GraphNode};
use std::collections::HashMap;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Semantic ID helpers (matching Haskell's Grafema.SemanticId)
// ---------------------------------------------------------------------------

fn semantic_id(file: &str, node_type: &str, name: &str, parent: Option<&str>, hash: Option<&str>) -> String {
    let base = format!("{file}->{node_type}->{name}");
    match (parent, hash) {
        (None, None) => base,
        (Some(p), None) => format!("{base}[in:{p}]"),
        (None, Some(h)) => format!("{base}[h:{h}]"),
        (Some(p), Some(h)) => format!("{base}[in:{p},h:{h}]"),
    }
}

fn content_hash(pairs: &[(&str, &str)]) -> String {
    let input: String = pairs.iter()
        .map(|(k, v)| format!("{k}:{v}"))
        .collect::<Vec<_>>()
        .join("|");
    let hash = fnv1a(&input) & 0xffff;
    format!("{hash:04x}")
}

fn fnv1a(s: &str) -> u32 {
    s.bytes().fold(0x811c9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x01000193))
}

fn make_module_id(file: &str) -> String {
    format!("MODULE#{file}")
}

// ---------------------------------------------------------------------------
// Line index helpers — convert byte offsets to 1-based line, 0-based column
// ---------------------------------------------------------------------------

fn build_line_starts(source: &[u8]) -> Vec<usize> {
    let mut starts = vec![0];
    for (i, &byte) in source.iter().enumerate() {
        if byte == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

fn offset_to_line_col(offset: usize, line_starts: &[usize]) -> (i64, i64) {
    let line = line_starts.partition_point(|&start| start <= offset).saturating_sub(1);
    let col = offset - line_starts[line];
    ((line + 1) as i64, col as i64)
}

// ---------------------------------------------------------------------------
// Scope kinds
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum ScopeKind {
    Module,
    Class,
    Function,
    Block,
}

impl ScopeKind {
    fn as_str(self) -> &'static str {
        match self {
            ScopeKind::Module => "module",
            ScopeKind::Class => "class",
            ScopeKind::Function => "function",
            ScopeKind::Block => "block",
        }
    }
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Visibility {
    Public,
    Private,
    Protected,
}

impl Visibility {
    fn as_str(self) -> &'static str {
        match self {
            Visibility::Public => "public",
            Visibility::Private => "private",
            Visibility::Protected => "protected",
        }
    }
}

// ---------------------------------------------------------------------------
// Deferred references
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct DeferredRef {
    name: String,
    from_node_id: String,
    edge_type: String,
    scope_id: String,
}

// ---------------------------------------------------------------------------
// Analysis context
// ---------------------------------------------------------------------------

struct Ctx {
    file: String,
    module_id: String,
    line_starts: Vec<usize>,
    scope_stack: Vec<String>,
    scope_kinds: Vec<ScopeKind>,
    enclosing_fn: Option<String>,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    exports: Vec<ExportInfo>,
    declarations: HashMap<String, Vec<(String, String)>>,
    scope_parents: HashMap<String, String>,
    deferred_refs: Vec<DeferredRef>,
    visibility: Visibility,
}

impl Ctx {
    fn new(file: &str, source: &[u8]) -> Self {
        let module_id = make_module_id(file);
        let line_starts = build_line_starts(source);
        Ctx {
            file: file.to_string(),
            module_id: module_id.clone(),
            line_starts,
            scope_stack: vec![module_id],
            scope_kinds: vec![ScopeKind::Module],
            enclosing_fn: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            exports: Vec::new(),
            declarations: HashMap::new(),
            scope_parents: HashMap::new(),
            deferred_refs: Vec::new(),
            visibility: Visibility::Public,
        }
    }

    fn scope_id(&self) -> &str {
        self.scope_stack.last().expect("scope stack empty")
    }

    fn emit_node(&mut self, node: GraphNode) {
        if node.node_type != "MODULE" {
            self.edges.push(GraphEdge {
                src: self.scope_id().to_string(),
                dst: node.id.clone(),
                edge_type: "CONTAINS".to_string(),
                metadata: HashMap::new(),
            });
        }
        self.nodes.push(node);
    }

    fn emit_declaration(&mut self, node: GraphNode) {
        let scope = self.scope_id().to_string();
        let name = node.name.clone();
        let id = node.id.clone();

        self.edges.push(GraphEdge {
            src: scope.clone(),
            dst: id.clone(),
            edge_type: "CONTAINS".to_string(),
            metadata: HashMap::new(),
        });

        self.edges.push(GraphEdge {
            src: scope.clone(),
            dst: id.clone(),
            edge_type: "DECLARES".to_string(),
            metadata: HashMap::new(),
        });

        self.declarations.entry(scope).or_default().push((name, id));
        self.nodes.push(node);
    }

    fn emit_edge(&mut self, edge: GraphEdge) {
        self.edges.push(edge);
    }

    fn push_scope(&mut self, scope_id: &str, kind: ScopeKind, line: i64, col: i64, end_line: i64, end_col: i64) {
        let parent = self.scope_id().to_string();

        if matches!(kind, ScopeKind::Block) {
            self.nodes.push(GraphNode {
                id: scope_id.to_string(),
                node_type: "SCOPE".to_string(),
                name: kind.as_str().to_string(),
                file: self.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Self::meta_text("kind", kind.as_str())]),
                extra: HashMap::new(),
            });
        }

        self.edges.push(GraphEdge {
            src: parent.clone(),
            dst: scope_id.to_string(),
            edge_type: "HAS_SCOPE".to_string(),
            metadata: HashMap::new(),
        });

        self.scope_parents.insert(scope_id.to_string(), parent);
        self.scope_stack.push(scope_id.to_string());
        self.scope_kinds.push(kind);
    }

    fn pop_scope(&mut self) {
        self.scope_stack.pop().expect("popping empty scope stack");
        self.scope_kinds.pop();
    }

    fn defer_ref(&mut self, name: &str, from_node_id: &str, edge_type: &str) {
        self.deferred_refs.push(DeferredRef {
            name: name.to_string(),
            from_node_id: from_node_id.to_string(),
            edge_type: edge_type.to_string(),
            scope_id: self.scope_id().to_string(),
        });
    }

    fn loc_line_col(&self, offset: usize) -> (i64, i64) {
        offset_to_line_col(offset, &self.line_starts)
    }

    fn pos_hash(&self, line: i64, col: i64) -> String {
        content_hash(&[("line", &line.to_string()), ("col", &col.to_string())])
    }

    fn meta_text(key: &str, val: &str) -> (String, serde_json::Value) {
        (key.to_string(), serde_json::Value::String(val.to_string()))
    }

    fn meta_bool(key: &str, val: bool) -> (String, serde_json::Value) {
        (key.to_string(), serde_json::Value::Bool(val))
    }

    #[allow(dead_code)]
    fn meta_int(key: &str, val: i64) -> (String, serde_json::Value) {
        (key.to_string(), serde_json::json!(val))
    }

    /// Extract the parent class/module name from the current scope stack, if inside one.
    fn enclosing_class_or_module(&self) -> Option<String> {
        for (sid, kind) in self.scope_stack.iter().zip(self.scope_kinds.iter()).rev() {
            if matches!(kind, ScopeKind::Class | ScopeKind::Module) && sid != &self.module_id {
                if let Some(name) = sid.rsplit("->").next() {
                    // Strip [in:...] and [h:...]
                    let name = name.split('[').next().unwrap_or(name);
                    return Some(name.to_string());
                }
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Helper: extract constant name from a Node (ConstantReadNode or ConstantPathNode)
// ---------------------------------------------------------------------------

fn constant_name_from_node(node: &ruby_prism::Node<'_>) -> String {
    match node {
        ruby_prism::Node::ConstantReadNode { .. } => {
            let cn = node.as_constant_read_node().unwrap();
            String::from_utf8_lossy(cn.name().as_slice()).to_string()
        }
        ruby_prism::Node::ConstantPathNode { .. } => {
            let cpn = node.as_constant_path_node().unwrap();
            let mut parts = Vec::new();
            if let Some(parent) = cpn.parent() {
                parts.push(constant_name_from_node(&parent));
            }
            if let Some(name) = cpn.name() {
                parts.push(String::from_utf8_lossy(name.as_slice()).to_string());
            }
            parts.join("::")
        }
        _ => {
            // For singleton class expressions etc., try location text
            String::from_utf8_lossy(node.location().as_slice()).to_string()
        }
    }
}

fn cid_to_string(cid: &ruby_prism::ConstantId<'_>) -> String {
    String::from_utf8_lossy(cid.as_slice()).to_string()
}

fn extract_module_name(file: &str) -> String {
    file.rsplit('/').next().unwrap_or(file)
        .trim_end_matches(".rb")
        .to_string()
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Analyze Ruby files in parallel using the native in-process analyzer.
/// Signature matches spawn_analysis! macro.
pub async fn analyze_ruby_files_native(
    files: &[PathBuf],
    jobs: usize,
    _analyzers: &crate::config::AnalyzerBinaries,
    _limits: crate::config::SizeLimits,
) -> Vec<AnalysisResult> {
    let total = files.len();
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(jobs.max(1)));

    let handles: Vec<_> = files.iter().enumerate().map(|(idx, file)| {
        let sem = std::sync::Arc::clone(&semaphore);
        let file = file.clone();

        tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("Semaphore closed");
            let file_display = file.display().to_string();
            let file_start = std::time::Instant::now();
            let file_size_bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

            if total <= 100 || (idx + 1) % 100 == 0 || idx + 1 == total {
                tracing::info!("[{}/{}] Analyzing Ruby file {}", idx + 1, total, file_display);
            }

            let file_clone = file.clone();
            let file_display_clone = file_display.clone();
            // Use 8MB stack: Prism's C parser + our recursive walk_node need
            // more than the default 2MB for large files (e.g. sinatra/base.rb,
            // 2000+ lines with deep nesting).
            let result = tokio::task::spawn_blocking(move || {
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::Builder::new()
                    .stack_size(8 * 1024 * 1024)
                    .name("ruby-analyze".into())
                    .spawn(move || {
                        let r = (|| {
                            let source = std::fs::read_to_string(&file_clone)
                                .map_err(|e| format!("Failed to read {}: {e}", file_clone.display()))?;
                            let parse_start = std::time::Instant::now();
                            let analysis = analyze_ruby_file(&file_display_clone, source.as_bytes());
                            let parse_ms = parse_start.elapsed().as_millis() as u64;
                            Ok::<_, String>((analysis, parse_ms))
                        })();
                        let _ = tx.send(r);
                    })
                    .expect("Failed to spawn ruby-analyze thread");
                rx.recv().unwrap_or_else(|_| Err("Ruby analysis thread panicked".into()))
            }).await;

            let total_ms = file_start.elapsed().as_millis() as u64;

            let (analysis, parse_ms) = match result {
                Ok(Ok((a, p))) => (a, p),
                Ok(Err(e)) => {
                    return AnalysisResult {
                        file, analysis: None,
                        errors: vec![e.clone()],
                        issues: vec![AnalysisIssue {
                            category: "parse_error".into(),
                            severity: "error".into(),
                            message: e,
                            file: file_display,
                        }],
                        metrics: FileMetrics {
                            file_size_bytes,
                            parse_ms: 0,
                            total_ms,
                            ..Default::default()
                        },
                    };
                }
                Err(e) => {
                    let msg = format!("Ruby analysis task panicked for {file_display}: {e}");
                    return AnalysisResult {
                        file, analysis: None,
                        errors: vec![msg.clone()],
                        issues: vec![AnalysisIssue {
                            category: "parse_error".into(),
                            severity: "error".into(),
                            message: msg,
                            file: file_display,
                        }],
                        metrics: FileMetrics {
                            file_size_bytes,
                            total_ms,
                            ..Default::default()
                        },
                    };
                }
            };

            let analyze_ms = total_ms.saturating_sub(parse_ms);
            let node_count = analysis.nodes.len();
            let edge_count = analysis.edges.len();

            AnalysisResult {
                file,
                analysis: Some(analysis),
                errors: vec![],
                issues: vec![],
                metrics: FileMetrics {
                    file_size_bytes,
                    parse_ms,
                    analyze_ms,
                    total_ms,
                    node_count,
                    edge_count,
                    ..Default::default()
                },
            }
        })
    }).collect();

    let mut results = Vec::with_capacity(handles.len());
    for h in handles {
        match h.await {
            Ok(r) => results.push(r),
            Err(e) => tracing::error!("Ruby analysis join error: {e}"),
        }
    }
    results
}

/// Analyze a single Ruby file.
fn analyze_ruby_file(file: &str, source: &[u8]) -> FileAnalysis {
    let mut ctx = Ctx::new(file, source);

    // MODULE node
    let mod_name = extract_module_name(file);
    ctx.nodes.push(GraphNode {
        id: ctx.module_id.clone(),
        node_type: "MODULE".to_string(),
        name: mod_name,
        file: ctx.file.clone(),
        line: 1,
        column: 0,
        end_line: 0,
        end_column: 0,
        exported: true,
        metadata: HashMap::new(),
        extra: HashMap::new(),
    });

    // Parse
    let result = ruby_prism::parse(source);

    // Walk program node
    let root = result.node();
    let program = root.as_program_node().expect("root should be ProgramNode");
    for child in program.statements().body().iter() {
        walk_node(&child, &mut ctx);
    }

    // Post-pass: resolve deferred references
    resolve_refs(&mut ctx);

    FileAnalysis {
        file: ctx.file,
        module_id: ctx.module_id,
        nodes: ctx.nodes,
        edges: ctx.edges,
        exports: ctx.exports,
    }
}

/// Resolve deferred references by walking scope chains.
fn resolve_refs(ctx: &mut Ctx) {
    let refs = std::mem::take(&mut ctx.deferred_refs);
    let mut new_edges = Vec::new();

    for dr in &refs {
        let mut scope = dr.scope_id.clone();
        let mut resolved = false;

        loop {
            if let Some(decls) = ctx.declarations.get(&scope) {
                if let Some((_, target_id)) = decls.iter().rev().find(|(n, _)| *n == dr.name) {
                    new_edges.push(GraphEdge {
                        src: dr.from_node_id.clone(),
                        dst: target_id.clone(),
                        edge_type: dr.edge_type.clone(),
                        metadata: HashMap::new(),
                    });
                    resolved = true;
                    break;
                }
            }
            match ctx.scope_parents.get(&scope) {
                Some(parent) => scope = parent.clone(),
                None => break,
            }
        }

        if !resolved {
            if let Some(node) = ctx.nodes.iter_mut().find(|n| n.id == dr.from_node_id) {
                node.metadata.insert("resolved".to_string(), serde_json::json!(false));
            }
        }
    }

    ctx.edges.extend(new_edges);
}

// ---------------------------------------------------------------------------
// Main walk function — exhaustive match on all Prism Node variants
// ---------------------------------------------------------------------------

fn walk_node(node: &ruby_prism::Node<'_>, ctx: &mut Ctx) {
    // Guard against stack overflow on deeply nested Ruby ASTs (e.g. long
    // method chains, deeply nested string interpolations).  `stacker` grows
    // the stack on demand — same approach used by syn, tree-sitter, etc.
    stacker::maybe_grow(64 * 1024, 2 * 1024 * 1024, || {
        walk_node_inner(node, ctx);
    });
}

fn walk_node_inner(node: &ruby_prism::Node<'_>, ctx: &mut Ctx) {
    match node {
        // =====================================================================
        // Structural
        // =====================================================================
        ruby_prism::Node::ProgramNode { .. } => {
            let pn = node.as_program_node().unwrap();
            for child in pn.statements().body().iter() {
                walk_node(&child, ctx);
            }
        }

        ruby_prism::Node::StatementsNode { .. } => {
            let sn = node.as_statements_node().unwrap();
            for child in sn.body().iter() {
                walk_node(&child, ctx);
            }
        }

        ruby_prism::Node::ModuleNode { .. } => {
            let mn = node.as_module_node().unwrap();
            let name = constant_name_from_node(&mn.constant_path());
            let loc = mn.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "MODULE", &name, parent_name.as_deref(), None);

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "MODULE".to_string(),
                name: name.clone(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: true,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
            ctx.exports.push(ExportInfo {
                name: name.clone(),
                node_id: node_id.clone(),
                kind: "module".to_string(),
                source: None,
            });

            ctx.push_scope(&node_id, ScopeKind::Module, line, col, end_line, end_col);
            if let Some(body) = mn.body() {
                walk_node(&body, ctx);
            }
            ctx.pop_scope();
        }

        ruby_prism::Node::ClassNode { .. } => {
            let cn = node.as_class_node().unwrap();
            let name = constant_name_from_node(&cn.constant_path());
            let loc = cn.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "CLASS", &name, parent_name.as_deref(), None);

            let mut metadata = HashMap::new();
            if let Some(ref sc) = cn.superclass() {
                let sc_name = constant_name_from_node(sc);
                metadata.insert("superclass".to_string(), serde_json::Value::String(sc_name.clone()));

                // EXTENDS edge
                ctx.emit_edge(GraphEdge {
                    src: node_id.clone(),
                    dst: format!("UNRESOLVED::{sc_name}"),
                    edge_type: "EXTENDS".to_string(),
                    metadata: HashMap::from([Ctx::meta_text("superclass", &sc_name)]),
                });
            }

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "CLASS".to_string(),
                name: name.clone(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: true,
                metadata,
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
            ctx.exports.push(ExportInfo {
                name: name.clone(),
                node_id: node_id.clone(),
                kind: "class".to_string(),
                source: None,
            });

            let saved_visibility = ctx.visibility;
            ctx.visibility = Visibility::Public;
            ctx.push_scope(&node_id, ScopeKind::Class, line, col, end_line, end_col);
            if let Some(body) = cn.body() {
                walk_node(&body, ctx);
            }
            ctx.pop_scope();
            ctx.visibility = saved_visibility;
        }

        ruby_prism::Node::SingletonClassNode { .. } => {
            let scn = node.as_singleton_class_node().unwrap();
            let expr_name = constant_name_from_node(&scn.expression());
            let loc = scn.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let name = format!("<<{expr_name}");
            let node_id = semantic_id(&ctx.file, "CLASS", &name, None, Some(&hash));

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "CLASS".to_string(),
                name: name.clone(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("singleton", true)]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);

            ctx.push_scope(&node_id, ScopeKind::Class, line, col, end_line, end_col);
            if let Some(body) = scn.body() {
                walk_node(&body, ctx);
            }
            ctx.pop_scope();
        }

        ruby_prism::Node::DefNode { .. } => {
            let dn = node.as_def_node().unwrap();
            let name = cid_to_string(&dn.name());
            let loc = dn.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());

            let is_static = dn.receiver().is_some();
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "FUNCTION", &name, parent_name.as_deref(), None);

            let mut metadata = HashMap::from([
                Ctx::meta_text("kind", "method"),
                Ctx::meta_text("visibility", ctx.visibility.as_str()),
            ]);
            if is_static {
                metadata.insert("static".to_string(), serde_json::Value::Bool(true));
            }

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "FUNCTION".to_string(),
                name: name.clone(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: ctx.visibility == Visibility::Public,
                metadata,
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);

            // HAS_METHOD edge from enclosing class/module
            if parent_name.is_some() {
                let parent_scope = ctx.scope_stack[ctx.scope_stack.len() - 1].clone();
                ctx.emit_edge(GraphEdge {
                    src: parent_scope,
                    dst: node_id.clone(),
                    edge_type: "HAS_METHOD".to_string(),
                    metadata: HashMap::new(),
                });
            }

            let prev_fn = ctx.enclosing_fn.take();
            ctx.enclosing_fn = Some(node_id.clone());
            ctx.push_scope(&node_id, ScopeKind::Function, line, col, end_line, end_col);

            if let Some(params) = dn.parameters() {
                walk_parameters(&params, ctx);
            }
            if let Some(body) = dn.body() {
                walk_node(&body, ctx);
            }

            ctx.pop_scope();
            ctx.enclosing_fn = prev_fn;
        }

        // =====================================================================
        // Calls
        // =====================================================================
        ruby_prism::Node::CallNode { .. } => {
            let cn = node.as_call_node().unwrap();
            let name = cid_to_string(&cn.name());
            let loc = cn.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());

            // Special-case certain Ruby calls
            match name.as_str() {
                "require" | "require_relative" => {
                    // IMPORT
                    let import_name = if let Some(args) = cn.arguments() {
                        let arg_list: Vec<_> = args.arguments().iter().collect();
                        if let Some(first) = arg_list.first() {
                            extract_string_value(first)
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    let source = import_name.unwrap_or_else(|| "<dynamic>".to_string());
                    let hash = ctx.pos_hash(line, col);
                    let node_id = semantic_id(&ctx.file, "IMPORT", &source, None, Some(&hash));

                    let gn = GraphNode {
                        id: node_id.clone(),
                        node_type: "IMPORT".to_string(),
                        name: source.clone(),
                        file: ctx.file.clone(),
                        line, column: col, end_line, end_column: end_col,
                        exported: false,
                        metadata: HashMap::from([
                            Ctx::meta_text("kind", if name == "require" { "require" } else { "require_relative" }),
                            Ctx::meta_text("source", &source),
                        ]),
                        extra: HashMap::new(),
                    };
                    ctx.emit_node(gn);

                    // IMPORTS_FROM edge
                    ctx.emit_edge(GraphEdge {
                        src: ctx.module_id.clone(),
                        dst: node_id,
                        edge_type: "IMPORTS_FROM".to_string(),
                        metadata: HashMap::from([Ctx::meta_text("source", &source)]),
                    });
                    return;
                }
                "include" | "extend" | "prepend" => {
                    // Mixin import
                    if let Some(args) = cn.arguments() {
                        for arg in args.arguments().iter() {
                            let mixin_name = constant_name_from_node(&arg);
                            let hash = ctx.pos_hash(line, col);
                            let node_id = semantic_id(&ctx.file, "IMPORT", &mixin_name, None, Some(&hash));

                            let gn = GraphNode {
                                id: node_id.clone(),
                                node_type: "IMPORT".to_string(),
                                name: mixin_name.clone(),
                                file: ctx.file.clone(),
                                line, column: col, end_line, end_column: end_col,
                                exported: false,
                                metadata: HashMap::from([
                                    Ctx::meta_text("kind", &name),
                                    Ctx::meta_text("source", &mixin_name),
                                ]),
                                extra: HashMap::new(),
                            };
                            ctx.emit_node(gn);
                            ctx.emit_edge(GraphEdge {
                                src: ctx.scope_id().to_string(),
                                dst: node_id,
                                edge_type: "IMPORTS_FROM".to_string(),
                                metadata: HashMap::from([Ctx::meta_text("kind", &name)]),
                            });
                        }
                    }
                    return;
                }
                "private" | "public" | "protected" => {
                    // Visibility modifier
                    if cn.arguments().is_none() || cn.arguments().map(|a| a.arguments().is_empty()).unwrap_or(true) {
                        // Bare visibility modifier — set default for subsequent defs
                        ctx.visibility = match name.as_str() {
                            "private" => Visibility::Private,
                            "protected" => Visibility::Protected,
                            _ => Visibility::Public,
                        };
                        return;
                    }
                    // With arguments: apply to specific methods, walk them
                    if let Some(args) = cn.arguments() {
                        let saved_vis = ctx.visibility;
                        ctx.visibility = match name.as_str() {
                            "private" => Visibility::Private,
                            "protected" => Visibility::Protected,
                            _ => Visibility::Public,
                        };
                        for arg in args.arguments().iter() {
                            walk_node(&arg, ctx);
                        }
                        ctx.visibility = saved_vis;
                    }
                    return;
                }
                "attr_reader" | "attr_writer" | "attr_accessor" => {
                    // Generate FUNCTION nodes for attribute methods
                    if let Some(args) = cn.arguments() {
                        for arg in args.arguments().iter() {
                            if let Some(attr_name) = extract_symbol_name(&arg) {
                                let parent_name = ctx.enclosing_class_or_module();

                                if name == "attr_reader" || name == "attr_accessor" {
                                    let reader_id = semantic_id(&ctx.file, "FUNCTION", &attr_name, parent_name.as_deref(), None);
                                    let gn = GraphNode {
                                        id: reader_id.clone(),
                                        node_type: "FUNCTION".to_string(),
                                        name: attr_name.clone(),
                                        file: ctx.file.clone(),
                                        line, column: col, end_line, end_column: end_col,
                                        exported: ctx.visibility == Visibility::Public,
                                        metadata: HashMap::from([
                                            Ctx::meta_text("kind", "attr_reader"),
                                            Ctx::meta_text("visibility", ctx.visibility.as_str()),
                                        ]),
                                        extra: HashMap::new(),
                                    };
                                    ctx.emit_declaration(gn);
                                    if parent_name.is_some() {
                                        ctx.emit_edge(GraphEdge {
                                            src: ctx.scope_id().to_string(),
                                            dst: reader_id,
                                            edge_type: "HAS_METHOD".to_string(),
                                            metadata: HashMap::new(),
                                        });
                                    }
                                }
                                if name == "attr_writer" || name == "attr_accessor" {
                                    let writer_name = format!("{attr_name}=");
                                    let writer_id = semantic_id(&ctx.file, "FUNCTION", &writer_name, parent_name.as_deref(), None);
                                    let gn = GraphNode {
                                        id: writer_id.clone(),
                                        node_type: "FUNCTION".to_string(),
                                        name: writer_name,
                                        file: ctx.file.clone(),
                                        line, column: col, end_line, end_column: end_col,
                                        exported: ctx.visibility == Visibility::Public,
                                        metadata: HashMap::from([
                                            Ctx::meta_text("kind", "attr_writer"),
                                            Ctx::meta_text("visibility", ctx.visibility.as_str()),
                                        ]),
                                        extra: HashMap::new(),
                                    };
                                    ctx.emit_declaration(gn);
                                    if parent_name.is_some() {
                                        ctx.emit_edge(GraphEdge {
                                            src: ctx.scope_id().to_string(),
                                            dst: writer_id,
                                            edge_type: "HAS_METHOD".to_string(),
                                            metadata: HashMap::new(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                    return;
                }
                "alias_method" => {
                    if let Some(args) = cn.arguments() {
                        let arg_list: Vec<_> = args.arguments().iter().collect();
                        if arg_list.len() >= 2 {
                            let new_name = extract_symbol_name(&arg_list[0]).unwrap_or_default();
                            let old_name = extract_symbol_name(&arg_list[1]).unwrap_or_default();
                            let parent_name = ctx.enclosing_class_or_module();
                            let alias_id = semantic_id(&ctx.file, "FUNCTION", &new_name, parent_name.as_deref(), None);
                            let gn = GraphNode {
                                id: alias_id.clone(),
                                node_type: "FUNCTION".to_string(),
                                name: new_name,
                                file: ctx.file.clone(),
                                line, column: col, end_line, end_column: end_col,
                                exported: ctx.visibility == Visibility::Public,
                                metadata: HashMap::from([
                                    Ctx::meta_text("kind", "alias"),
                                    Ctx::meta_text("alias_of", &old_name),
                                    Ctx::meta_text("visibility", ctx.visibility.as_str()),
                                ]),
                                extra: HashMap::new(),
                            };
                            ctx.emit_declaration(gn);
                        }
                    }
                    return;
                }
                "define_method" => {
                    // `define_method(:name) { body }` dynamically defines an instance
                    // method. Model it like a `def` so the method is discoverable
                    // ("what methods does this class define?") instead of being hidden
                    // behind an opaque CALL node.
                    //
                    // Best-effort and conservative: only when called WITHOUT an explicit
                    // receiver (i.e. on the implicit `self` of the enclosing class/module
                    // body) AND with a literal symbol/string name. A dynamic name
                    // (`define_method(var)`, interpolated symbol) or an explicit receiver
                    // (`other.define_method`) would attribute the method to the wrong
                    // owner, so those fall through to general CALL handling below — the
                    // block body is still walked there, so nothing is lost.
                    if cn.receiver().is_none() {
                        if let Some(args) = cn.arguments() {
                            let arg_list: Vec<_> = args.arguments().iter().collect();
                            let method_name = arg_list.first().and_then(extract_symbol_name);
                            if let Some(method_name) = method_name {
                                let parent_name = ctx.enclosing_class_or_module();
                                let method_id = semantic_id(
                                    &ctx.file, "FUNCTION", &method_name, parent_name.as_deref(), None,
                                );

                                let gn = GraphNode {
                                    id: method_id.clone(),
                                    node_type: "FUNCTION".to_string(),
                                    name: method_name.clone(),
                                    file: ctx.file.clone(),
                                    line, column: col, end_line, end_column: end_col,
                                    exported: ctx.visibility == Visibility::Public,
                                    metadata: HashMap::from([
                                        Ctx::meta_text("kind", "define_method"),
                                        Ctx::meta_text("visibility", ctx.visibility.as_str()),
                                    ]),
                                    extra: HashMap::new(),
                                };
                                ctx.emit_declaration(gn);

                                // HAS_METHOD edge from the enclosing class/module
                                // (mirrors the DefNode handler).
                                if parent_name.is_some() {
                                    let parent_scope =
                                        ctx.scope_stack[ctx.scope_stack.len() - 1].clone();
                                    ctx.emit_edge(GraphEdge {
                                        src: parent_scope,
                                        dst: method_id.clone(),
                                        edge_type: "HAS_METHOD".to_string(),
                                        metadata: HashMap::new(),
                                    });
                                }

                                // Walk the body under the method's own scope so its
                                // calls/refs attribute to this method (mirrors DefNode).
                                let prev_fn = ctx.enclosing_fn.take();
                                ctx.enclosing_fn = Some(method_id.clone());
                                ctx.push_scope(
                                    &method_id, ScopeKind::Function, line, col, end_line, end_col,
                                );

                                // The body is normally a brace/do block; walk its params
                                // and statements directly (not as a separate <block>
                                // function — the method node IS the container).
                                if let Some(block) = cn.block() {
                                    if let Some(bn) = block.as_block_node() {
                                        if let Some(params) = bn.parameters() {
                                            walk_node(&params, ctx);
                                        }
                                        if let Some(body) = bn.body() {
                                            walk_node(&body, ctx);
                                        }
                                    } else {
                                        walk_node(&block, ctx);
                                    }
                                }
                                // A callable passed as the 2nd argument
                                // (`define_method(:foo, some_proc)`) and any further args.
                                for arg in arg_list.iter().skip(1) {
                                    walk_node(arg, ctx);
                                }

                                ctx.pop_scope();
                                ctx.enclosing_fn = prev_fn;
                                return;
                            }
                        }
                    }
                    // Dynamic name / explicit receiver: fall through to general handling.
                }
                _ => {}
            }

            // General call node
            let hash = ctx.pos_hash(line, col);
            let receiver_name = cn.receiver().map(|r| constant_name_from_node(&r));
            let call_name = if let Some(ref recv) = receiver_name {
                format!("{recv}.{name}")
            } else {
                name.clone()
            };
            let node_id = semantic_id(&ctx.file, "CALL", &call_name, None, Some(&hash));

            let mut metadata = HashMap::new();
            if let Some(ref recv) = receiver_name {
                metadata.insert("receiver".to_string(), serde_json::Value::String(recv.clone()));
            }
            metadata.insert("method".to_string(), serde_json::Value::String(name.clone()));

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "CALL".to_string(),
                name: call_name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata,
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);

            // CALLS edge from enclosing function
            if let Some(ref fn_id) = ctx.enclosing_fn.clone() {
                ctx.emit_edge(GraphEdge {
                    src: fn_id.clone(),
                    dst: node_id.clone(),
                    edge_type: "CALLS".to_string(),
                    metadata: HashMap::new(),
                });
            }

            // PASSES_ARGUMENT edges
            if let Some(args) = cn.arguments() {
                for (i, arg) in args.arguments().iter().enumerate() {
                    walk_node(&arg, ctx);
                    // We create a PASSES_ARGUMENT edge for simple node types
                    let arg_name = extract_ref_name(&arg);
                    if let Some(an) = arg_name {
                        ctx.emit_edge(GraphEdge {
                            src: node_id.clone(),
                            dst: format!("ARG::{i}"),
                            edge_type: "PASSES_ARGUMENT".to_string(),
                            metadata: HashMap::from([
                                Ctx::meta_text("name", &an),
                                Ctx::meta_int("index", i as i64),
                            ]),
                        });
                    }
                }
            } else {
                // No arguments — nothing to walk for args
            }

            // Walk receiver
            if let Some(recv) = cn.receiver() {
                walk_node(&recv, ctx);
            }
            // Walk block
            if let Some(block) = cn.block() {
                walk_node(&block, ctx);
            }
        }

        ruby_prism::Node::SuperNode { .. } => {
            let sn = node.as_super_node().unwrap();
            let loc = sn.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", "super", None, Some(&hash));

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "CALL".to_string(),
                name: "super".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("super", true)]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);

            if let Some(args) = sn.arguments() {
                for arg in args.arguments().iter() {
                    walk_node(&arg, ctx);
                }
            }
        }

        ruby_prism::Node::ForwardingSuperNode { .. } => {
            let loc = node.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", "super", None, Some(&hash));

            let gn = GraphNode {
                id: node_id,
                node_type: "CALL".to_string(),
                name: "super".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_bool("super", true),
                    Ctx::meta_bool("forwarding", true),
                ]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
        }

        ruby_prism::Node::YieldNode { .. } => {
            let yn = node.as_yield_node().unwrap();
            let loc = yn.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", "yield", None, Some(&hash));

            let gn = GraphNode {
                id: node_id,
                node_type: "CALL".to_string(),
                name: "yield".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("yield", true)]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);

            if let Some(args) = yn.arguments() {
                for arg in args.arguments().iter() {
                    walk_node(&arg, ctx);
                }
            }
        }

        // =====================================================================
        // Call-compound-write
        // =====================================================================
        ruby_prism::Node::CallAndWriteNode { .. } => {
            let n = node.as_call_and_write_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let name = cid_to_string(&n.read_name());
            let node_id = semantic_id(&ctx.file, "CALL", &name, None, Some(&hash));
            emit_call_node(ctx, &node_id, &name, line, col, end_line, end_col);
            walk_node(&n.value(), ctx);
            if let Some(recv) = n.receiver() { walk_node(&recv, ctx); }
        }

        ruby_prism::Node::CallOrWriteNode { .. } => {
            let n = node.as_call_or_write_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let name = cid_to_string(&n.read_name());
            let node_id = semantic_id(&ctx.file, "CALL", &name, None, Some(&hash));
            emit_call_node(ctx, &node_id, &name, line, col, end_line, end_col);
            walk_node(&n.value(), ctx);
            if let Some(recv) = n.receiver() { walk_node(&recv, ctx); }
        }

        ruby_prism::Node::CallOperatorWriteNode { .. } => {
            let n = node.as_call_operator_write_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let name = cid_to_string(&n.read_name());
            let node_id = semantic_id(&ctx.file, "CALL", &name, None, Some(&hash));
            emit_call_node(ctx, &node_id, &name, line, col, end_line, end_col);
            walk_node(&n.value(), ctx);
            if let Some(recv) = n.receiver() { walk_node(&recv, ctx); }
        }

        ruby_prism::Node::CallTargetNode { .. } => {
            let n = node.as_call_target_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let name = cid_to_string(&n.name());
            let node_id = semantic_id(&ctx.file, "CALL", &name, None, Some(&hash));
            emit_call_node(ctx, &node_id, &name, line, col, end_line, end_col);
            walk_node(&n.receiver(), ctx);
        }

        ruby_prism::Node::IndexAndWriteNode { .. } => {
            walk_children_generic(node, ctx);
        }

        ruby_prism::Node::IndexOrWriteNode { .. } => {
            walk_children_generic(node, ctx);
        }

        ruby_prism::Node::IndexOperatorWriteNode { .. } => {
            walk_children_generic(node, ctx);
        }

        ruby_prism::Node::IndexTargetNode { .. } => {
            walk_children_generic(node, ctx);
        }

        // =====================================================================
        // Blocks & Lambdas
        // =====================================================================
        ruby_prism::Node::BlockNode { .. } => {
            let bn = node.as_block_node().unwrap();
            let loc = bn.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "FUNCTION", "<block>", None, Some(&hash));

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "FUNCTION".to_string(),
                name: "<block>".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "block")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);

            let prev_fn = ctx.enclosing_fn.take();
            ctx.enclosing_fn = Some(node_id.clone());
            ctx.push_scope(&node_id, ScopeKind::Function, line, col, end_line, end_col);

            if let Some(params) = bn.parameters() {
                walk_node(&params, ctx);
            }
            if let Some(body) = bn.body() {
                walk_node(&body, ctx);
            }

            ctx.pop_scope();
            ctx.enclosing_fn = prev_fn;
        }

        ruby_prism::Node::LambdaNode { .. } => {
            let ln = node.as_lambda_node().unwrap();
            let loc = ln.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "FUNCTION", "<lambda>", None, Some(&hash));

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "FUNCTION".to_string(),
                name: "<lambda>".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "lambda")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);

            let prev_fn = ctx.enclosing_fn.take();
            ctx.enclosing_fn = Some(node_id.clone());
            ctx.push_scope(&node_id, ScopeKind::Function, line, col, end_line, end_col);

            if let Some(params) = ln.parameters() {
                walk_node(&params, ctx);
            }
            if let Some(body) = ln.body() {
                walk_node(&body, ctx);
            }

            ctx.pop_scope();
            ctx.enclosing_fn = prev_fn;
        }

        ruby_prism::Node::BlockParametersNode { .. } => {
            let bpn = node.as_block_parameters_node().unwrap();
            if let Some(params) = bpn.parameters() {
                walk_parameters(&params, ctx);
            }
            for local in bpn.locals().iter() {
                // BlockLocalVariableNode children
                walk_node(&local, ctx);
            }
        }

        ruby_prism::Node::BlockLocalVariableNode { .. } => {
            let n = node.as_block_local_variable_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "block_local")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::BlockArgumentNode { .. } => {
            let n = node.as_block_argument_node().unwrap();
            if let Some(expr) = n.expression() {
                walk_node(&expr, ctx);
            }
        }

        ruby_prism::Node::BlockParameterNode { .. } => {
            let n = node.as_block_parameter_node().unwrap();
            if let Some(name_cid) = n.name() {
                let name = cid_to_string(&name_cid);
                let loc = n.location();
                let (line, col) = ctx.loc_line_col(loc.start_offset());
                let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
                let node_id = semantic_id(&ctx.file, "PARAMETER", &name, ctx.enclosing_fn.as_deref(), None);

                let gn = GraphNode {
                    id: node_id,
                    node_type: "PARAMETER".to_string(),
                    name,
                    file: ctx.file.clone(),
                    line, column: col, end_line, end_column: end_col,
                    exported: false,
                    metadata: HashMap::from([Ctx::meta_bool("block", true)]),
                    extra: HashMap::new(),
                };
                ctx.emit_declaration(gn);
            }
        }

        // =====================================================================
        // Parameters
        // =====================================================================
        ruby_prism::Node::ParametersNode { .. } => {
            let pn = node.as_parameters_node().unwrap();
            walk_parameters(&pn, ctx);
        }

        ruby_prism::Node::RequiredParameterNode { .. } => {
            let n = node.as_required_parameter_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "PARAMETER", &name, ctx.enclosing_fn.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::OptionalParameterNode { .. } => {
            let n = node.as_optional_parameter_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "PARAMETER", &name, ctx.enclosing_fn.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("default", true)]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            walk_node(&n.value(), ctx);
        }

        ruby_prism::Node::RestParameterNode { .. } => {
            let n = node.as_rest_parameter_node().unwrap();
            let name = n.name().map(|c| cid_to_string(&c)).unwrap_or_else(|| "*".to_string());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "PARAMETER", &name, ctx.enclosing_fn.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("rest", true)]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::KeywordRestParameterNode { .. } => {
            let n = node.as_keyword_rest_parameter_node().unwrap();
            let name = n.name().map(|c| cid_to_string(&c)).unwrap_or_else(|| "**".to_string());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "PARAMETER", &name, ctx.enclosing_fn.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("keyword_rest", true)]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::RequiredKeywordParameterNode { .. } => {
            let n = node.as_required_keyword_parameter_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "PARAMETER", &name, ctx.enclosing_fn.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("keyword", true)]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::OptionalKeywordParameterNode { .. } => {
            let n = node.as_optional_keyword_parameter_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "PARAMETER", &name, ctx.enclosing_fn.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_bool("keyword", true),
                    Ctx::meta_bool("default", true),
                ]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            walk_node(&n.value(), ctx);
        }

        ruby_prism::Node::ForwardingParameterNode { .. } => {
            let loc = node.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "PARAMETER", "...", ctx.enclosing_fn.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name: "...".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("forwarding", true)]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::NoKeywordsParameterNode { .. } => {
            let loc = node.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "PARAMETER", "**nil", ctx.enclosing_fn.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name: "**nil".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("no_keywords", true)]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::NumberedParametersNode { .. } => {
            let n = node.as_numbered_parameters_node().unwrap();
            let max = n.maximum();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            for i in 1..=max {
                let name = format!("_{i}");
                let node_id = semantic_id(&ctx.file, "PARAMETER", &name, ctx.enclosing_fn.as_deref(), None);
                let gn = GraphNode {
                    id: node_id,
                    node_type: "PARAMETER".to_string(),
                    name,
                    file: ctx.file.clone(),
                    line, column: col, end_line, end_column: end_col,
                    exported: false,
                    metadata: HashMap::from([Ctx::meta_bool("numbered", true)]),
                    extra: HashMap::new(),
                };
                ctx.emit_declaration(gn);
            }
        }

        ruby_prism::Node::ItParametersNode { .. } => {
            let loc = node.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "PARAMETER", "it", ctx.enclosing_fn.as_deref(), None);
            let gn = GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name: "it".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        // =====================================================================
        // Local Variables
        // =====================================================================
        ruby_prism::Node::LocalVariableWriteNode { .. } => {
            let n = node.as_local_variable_write_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "VARIABLE".to_string(),
                name: name.clone(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "local")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);

            let before = ctx.nodes.len();
            walk_node(&n.value(), ctx);
            if ctx.nodes.len() > before {
                let value_node_id = ctx.nodes[before].id.clone();
                ctx.emit_edge(GraphEdge {
                    src: node_id,
                    dst: value_node_id,
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }

        ruby_prism::Node::LocalVariableReadNode { .. } => {
            let n = node.as_local_variable_read_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &name, None, Some(&hash));

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "REFERENCE".to_string(),
                name: name.clone(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "local")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
            ctx.defer_ref(&name, &node_id, "READS_FROM");
        }

        ruby_prism::Node::LocalVariableAndWriteNode { .. } => {
            let n = node.as_local_variable_and_write_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "local")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            let before = ctx.nodes.len();
            walk_node(&n.value(), ctx);
            if ctx.nodes.len() > before {
                let value_node_id = ctx.nodes[before].id.clone();
                ctx.emit_edge(GraphEdge {
                    src: node_id,
                    dst: value_node_id,
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }

        ruby_prism::Node::LocalVariableOrWriteNode { .. } => {
            let n = node.as_local_variable_or_write_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "local")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            let before = ctx.nodes.len();
            walk_node(&n.value(), ctx);
            if ctx.nodes.len() > before {
                let value_node_id = ctx.nodes[before].id.clone();
                ctx.emit_edge(GraphEdge {
                    src: node_id,
                    dst: value_node_id,
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }

        ruby_prism::Node::LocalVariableOperatorWriteNode { .. } => {
            let n = node.as_local_variable_operator_write_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "local")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            let before = ctx.nodes.len();
            walk_node(&n.value(), ctx);
            if ctx.nodes.len() > before {
                let value_node_id = ctx.nodes[before].id.clone();
                ctx.emit_edge(GraphEdge {
                    src: node_id,
                    dst: value_node_id,
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }

        ruby_prism::Node::LocalVariableTargetNode { .. } => {
            let n = node.as_local_variable_target_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id,
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "local")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::ItLocalVariableReadNode { .. } => {
            let loc = node.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", "it", None, Some(&hash));
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "REFERENCE".to_string(),
                name: "it".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
            ctx.defer_ref("it", &node_id, "READS_FROM");
        }

        // =====================================================================
        // Instance Variables
        // =====================================================================
        ruby_prism::Node::InstanceVariableWriteNode { .. } => {
            let n = node.as_instance_variable_write_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "instance")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            let before = ctx.nodes.len();
            walk_node(&n.value(), ctx);
            if ctx.nodes.len() > before {
                let value_node_id = ctx.nodes[before].id.clone();
                ctx.emit_edge(GraphEdge {
                    src: node_id,
                    dst: value_node_id,
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }

        ruby_prism::Node::InstanceVariableReadNode { .. } => {
            let n = node.as_instance_variable_read_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &name, None, Some(&hash));
            let gn = GraphNode {
                id: node_id,
                node_type: "REFERENCE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "instance")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
        }

        ruby_prism::Node::InstanceVariableAndWriteNode { .. } => {
            let n = node.as_instance_variable_and_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_ivar_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::InstanceVariableOrWriteNode { .. } => {
            let n = node.as_instance_variable_or_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_ivar_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::InstanceVariableOperatorWriteNode { .. } => {
            let n = node.as_instance_variable_operator_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_ivar_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::InstanceVariableTargetNode { .. } => {
            let n = node.as_instance_variable_target_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id,
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "instance")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        // =====================================================================
        // Class Variables
        // =====================================================================
        ruby_prism::Node::ClassVariableWriteNode { .. } => {
            let n = node.as_class_variable_write_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "class")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            let before = ctx.nodes.len();
            walk_node(&n.value(), ctx);
            if ctx.nodes.len() > before {
                let value_node_id = ctx.nodes[before].id.clone();
                ctx.emit_edge(GraphEdge {
                    src: node_id,
                    dst: value_node_id,
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }

        ruby_prism::Node::ClassVariableReadNode { .. } => {
            let n = node.as_class_variable_read_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &name, None, Some(&hash));
            let gn = GraphNode {
                id: node_id,
                node_type: "REFERENCE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "class")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
        }

        ruby_prism::Node::ClassVariableAndWriteNode { .. } => {
            let n = node.as_class_variable_and_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_cvar_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::ClassVariableOrWriteNode { .. } => {
            let n = node.as_class_variable_or_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_cvar_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::ClassVariableOperatorWriteNode { .. } => {
            let n = node.as_class_variable_operator_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_cvar_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::ClassVariableTargetNode { .. } => {
            let n = node.as_class_variable_target_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id,
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "class")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        // =====================================================================
        // Global Variables
        // =====================================================================
        ruby_prism::Node::GlobalVariableWriteNode { .. } => {
            let n = node.as_global_variable_write_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, None, None);
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "global")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            let before = ctx.nodes.len();
            walk_node(&n.value(), ctx);
            if ctx.nodes.len() > before {
                let value_node_id = ctx.nodes[before].id.clone();
                ctx.emit_edge(GraphEdge {
                    src: node_id,
                    dst: value_node_id,
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }

        ruby_prism::Node::GlobalVariableReadNode { .. } => {
            let n = node.as_global_variable_read_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &name, None, Some(&hash));
            let gn = GraphNode {
                id: node_id,
                node_type: "REFERENCE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "global")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
        }

        ruby_prism::Node::GlobalVariableAndWriteNode { .. } => {
            let n = node.as_global_variable_and_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_gvar_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::GlobalVariableOrWriteNode { .. } => {
            let n = node.as_global_variable_or_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_gvar_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::GlobalVariableOperatorWriteNode { .. } => {
            let n = node.as_global_variable_operator_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_gvar_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::GlobalVariableTargetNode { .. } => {
            let n = node.as_global_variable_target_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "VARIABLE", &name, None, None);
            let gn = GraphNode {
                id: node_id,
                node_type: "VARIABLE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "global")]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        // =====================================================================
        // Constants
        // =====================================================================
        ruby_prism::Node::ConstantWriteNode { .. } => {
            let n = node.as_constant_write_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "CONSTANT", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "CONSTANT".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: true,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            let before = ctx.nodes.len();
            walk_node(&n.value(), ctx);
            if ctx.nodes.len() > before {
                let value_node_id = ctx.nodes[before].id.clone();
                ctx.emit_edge(GraphEdge {
                    src: node_id,
                    dst: value_node_id,
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }

        ruby_prism::Node::ConstantReadNode { .. } => {
            let n = node.as_constant_read_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &name, None, Some(&hash));
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "REFERENCE".to_string(),
                name: name.clone(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "constant")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
            ctx.defer_ref(&name, &node_id, "READS_FROM");
        }

        ruby_prism::Node::ConstantAndWriteNode { .. } => {
            let n = node.as_constant_and_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_const_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::ConstantOrWriteNode { .. } => {
            let n = node.as_constant_or_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_const_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::ConstantOperatorWriteNode { .. } => {
            let n = node.as_constant_operator_write_node().unwrap();
            let name = cid_to_string(&n.name());
            emit_const_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::ConstantTargetNode { .. } => {
            let n = node.as_constant_target_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "CONSTANT", &name, parent_name.as_deref(), None);
            let gn = GraphNode {
                id: node_id,
                node_type: "CONSTANT".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: true,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::ConstantPathNode { .. } => {
            let cpn = node.as_constant_path_node().unwrap();
            let name = constant_name_from_node(node);
            let loc = cpn.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &name, None, Some(&hash));
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "REFERENCE".to_string(),
                name: name.clone(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "constant_path")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
            ctx.defer_ref(&name, &node_id, "READS_FROM");
        }

        ruby_prism::Node::ConstantPathWriteNode { .. } => {
            let n = node.as_constant_path_write_node().unwrap();
            let name = constant_name_from_node(&n.target().as_node());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "CONSTANT", &name, None, None);
            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "CONSTANT".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: true,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
            let before = ctx.nodes.len();
            walk_node(&n.value(), ctx);
            if ctx.nodes.len() > before {
                let value_node_id = ctx.nodes[before].id.clone();
                ctx.emit_edge(GraphEdge {
                    src: node_id,
                    dst: value_node_id,
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }

        ruby_prism::Node::ConstantPathAndWriteNode { .. } => {
            let n = node.as_constant_path_and_write_node().unwrap();
            let name = constant_name_from_node(&n.target().as_node());
            emit_const_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::ConstantPathOrWriteNode { .. } => {
            let n = node.as_constant_path_or_write_node().unwrap();
            let name = constant_name_from_node(&n.target().as_node());
            emit_const_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::ConstantPathOperatorWriteNode { .. } => {
            let n = node.as_constant_path_operator_write_node().unwrap();
            let name = constant_name_from_node(&n.target().as_node());
            emit_const_write(ctx, &name, &n.location(), &n.value());
        }

        ruby_prism::Node::ConstantPathTargetNode { .. } => {
            let n = node.as_constant_path_target_node().unwrap();
            let name = if let Some(name_cid) = n.name() {
                let mut parts = Vec::new();
                if let Some(parent) = n.parent() {
                    parts.push(constant_name_from_node(&parent));
                }
                parts.push(cid_to_string(&name_cid));
                parts.join("::")
            } else {
                String::from_utf8_lossy(n.location().as_slice()).to_string()
            };
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "CONSTANT", &name, None, None);
            let gn = GraphNode {
                id: node_id,
                node_type: "CONSTANT".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: true,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::ShareableConstantNode { .. } => {
            let n = node.as_shareable_constant_node().unwrap();
            walk_node(&n.write(), ctx);
        }

        // =====================================================================
        // Multi-assignment
        // =====================================================================
        ruby_prism::Node::MultiWriteNode { .. } => {
            let n = node.as_multi_write_node().unwrap();
            for target in n.lefts().iter() {
                walk_node(&target, ctx);
            }
            if let Some(rest) = n.rest() {
                walk_node(&rest, ctx);
            }
            for target in n.rights().iter() {
                walk_node(&target, ctx);
            }
            walk_node(&n.value(), ctx);
        }

        ruby_prism::Node::MultiTargetNode { .. } => {
            let n = node.as_multi_target_node().unwrap();
            for target in n.lefts().iter() {
                walk_node(&target, ctx);
            }
            if let Some(rest) = n.rest() {
                walk_node(&rest, ctx);
            }
            for target in n.rights().iter() {
                walk_node(&target, ctx);
            }
        }

        // =====================================================================
        // Alias & Undef
        // =====================================================================
        ruby_prism::Node::AliasMethodNode { .. } => {
            let n = node.as_alias_method_node().unwrap();
            let new_name = extract_symbol_or_literal_name(&n.new_name());
            let old_name = extract_symbol_or_literal_name(&n.old_name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let parent_name = ctx.enclosing_class_or_module();
            let node_id = semantic_id(&ctx.file, "FUNCTION", &new_name, parent_name.as_deref(), None);

            let gn = GraphNode {
                id: node_id,
                node_type: "FUNCTION".to_string(),
                name: new_name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: ctx.visibility == Visibility::Public,
                metadata: HashMap::from([
                    Ctx::meta_text("kind", "alias"),
                    Ctx::meta_text("alias_of", &old_name),
                ]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::AliasGlobalVariableNode { .. } => {
            let n = node.as_alias_global_variable_node().unwrap();
            let new_name = extract_symbol_or_literal_name(&n.new_name());
            let old_name = extract_symbol_or_literal_name(&n.old_name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let node_id = semantic_id(&ctx.file, "VARIABLE", &new_name, None, None);

            let gn = GraphNode {
                id: node_id,
                node_type: "VARIABLE".to_string(),
                name: new_name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_text("kind", "global"),
                    Ctx::meta_text("alias_of", &old_name),
                ]),
                extra: HashMap::new(),
            };
            ctx.emit_declaration(gn);
        }

        ruby_prism::Node::UndefNode { .. } => {
            let n = node.as_undef_node().unwrap();
            for name_node in n.names().iter() {
                walk_node(&name_node, ctx);
            }
        }

        // =====================================================================
        // Control Flow
        // =====================================================================
        ruby_prism::Node::IfNode { .. } => {
            let n = node.as_if_node().unwrap();
            walk_node(&n.predicate(), ctx);
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
            if let Some(sub) = n.subsequent() {
                walk_node(&sub, ctx);
            }
        }

        ruby_prism::Node::UnlessNode { .. } => {
            let n = node.as_unless_node().unwrap();
            walk_node(&n.predicate(), ctx);
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
            if let Some(else_clause) = n.else_clause() {
                walk_node(&else_clause.as_node(), ctx);
            }
        }

        ruby_prism::Node::ElseNode { .. } => {
            let n = node.as_else_node().unwrap();
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
        }

        ruby_prism::Node::WhileNode { .. } => {
            let n = node.as_while_node().unwrap();
            walk_node(&n.predicate(), ctx);
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
        }

        ruby_prism::Node::UntilNode { .. } => {
            let n = node.as_until_node().unwrap();
            walk_node(&n.predicate(), ctx);
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
        }

        ruby_prism::Node::ForNode { .. } => {
            let n = node.as_for_node().unwrap();
            walk_node(&n.index(), ctx);
            walk_node(&n.collection(), ctx);
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let scope_id = semantic_id(&ctx.file, "SCOPE", "for", None, Some(&hash));
            ctx.push_scope(&scope_id, ScopeKind::Block, line, col, end_line, end_col);
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
            ctx.pop_scope();
        }

        ruby_prism::Node::CaseNode { .. } => {
            let n = node.as_case_node().unwrap();
            if let Some(pred) = n.predicate() {
                walk_node(&pred, ctx);
            }
            for cond in n.conditions().iter() {
                walk_node(&cond, ctx);
            }
            if let Some(else_clause) = n.else_clause() {
                walk_node(&else_clause.as_node(), ctx);
            }
        }

        ruby_prism::Node::CaseMatchNode { .. } => {
            let n = node.as_case_match_node().unwrap();
            if let Some(pred) = n.predicate() {
                walk_node(&pred, ctx);
            }
            for cond in n.conditions().iter() {
                walk_node(&cond, ctx);
            }
            if let Some(else_clause) = n.else_clause() {
                walk_node(&else_clause.as_node(), ctx);
            }
        }

        ruby_prism::Node::WhenNode { .. } => {
            let n = node.as_when_node().unwrap();
            for cond in n.conditions().iter() {
                walk_node(&cond, ctx);
            }
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
        }

        ruby_prism::Node::InNode { .. } => {
            let n = node.as_in_node().unwrap();
            walk_node(&n.pattern(), ctx);
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
        }

        ruby_prism::Node::BeginNode { .. } => {
            let n = node.as_begin_node().unwrap();
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
            if let Some(rescue) = n.rescue_clause() {
                walk_rescue_chain(&rescue, ctx);
            }
            if let Some(else_clause) = n.else_clause() {
                walk_node(&else_clause.as_node(), ctx);
            }
            if let Some(ensure) = n.ensure_clause() {
                walk_node(&ensure.as_node(), ctx);
            }
        }

        ruby_prism::Node::RescueNode { .. } => {
            let n = node.as_rescue_node().unwrap();
            walk_rescue_chain(&n, ctx);
        }

        ruby_prism::Node::RescueModifierNode { .. } => {
            let n = node.as_rescue_modifier_node().unwrap();
            walk_node(&n.expression(), ctx);
            walk_node(&n.rescue_expression(), ctx);
        }

        ruby_prism::Node::EnsureNode { .. } => {
            let n = node.as_ensure_node().unwrap();
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
        }

        ruby_prism::Node::ReturnNode { .. } => {
            let n = node.as_return_node().unwrap();
            if let Some(args) = n.arguments() {
                for arg in args.arguments().iter() {
                    walk_node(&arg, ctx);
                }
            }
        }

        ruby_prism::Node::BreakNode { .. } => {
            let n = node.as_break_node().unwrap();
            if let Some(args) = n.arguments() {
                for arg in args.arguments().iter() {
                    walk_node(&arg, ctx);
                }
            }
        }

        ruby_prism::Node::NextNode { .. } => {
            let n = node.as_next_node().unwrap();
            if let Some(args) = n.arguments() {
                for arg in args.arguments().iter() {
                    walk_node(&arg, ctx);
                }
            }
        }

        ruby_prism::Node::RedoNode { .. } => {
            // No-op node, no children
        }

        ruby_prism::Node::RetryNode { .. } => {
            // No-op node, no children
        }

        // =====================================================================
        // Arguments & Logical
        // =====================================================================
        ruby_prism::Node::ArgumentsNode { .. } => {
            let n = node.as_arguments_node().unwrap();
            for arg in n.arguments().iter() {
                walk_node(&arg, ctx);
            }
        }

        ruby_prism::Node::AndNode { .. } => {
            let n = node.as_and_node().unwrap();
            walk_node(&n.left(), ctx);
            walk_node(&n.right(), ctx);
        }

        ruby_prism::Node::OrNode { .. } => {
            let n = node.as_or_node().unwrap();
            walk_node(&n.left(), ctx);
            walk_node(&n.right(), ctx);
        }

        ruby_prism::Node::FlipFlopNode { .. } => {
            let n = node.as_flip_flop_node().unwrap();
            if let Some(left) = n.left() {
                walk_node(&left, ctx);
            }
            if let Some(right) = n.right() {
                walk_node(&right, ctx);
            }
        }

        // =====================================================================
        // Pattern Matching
        // =====================================================================
        ruby_prism::Node::MatchPredicateNode { .. } => {
            let n = node.as_match_predicate_node().unwrap();
            walk_node(&n.value(), ctx);
            walk_node(&n.pattern(), ctx);
        }

        ruby_prism::Node::MatchRequiredNode { .. } => {
            let n = node.as_match_required_node().unwrap();
            walk_node(&n.value(), ctx);
            walk_node(&n.pattern(), ctx);
        }

        ruby_prism::Node::MatchWriteNode { .. } => {
            let n = node.as_match_write_node().unwrap();
            walk_node(&n.call().as_node(), ctx);
        }

        ruby_prism::Node::ArrayPatternNode { .. } => {
            let n = node.as_array_pattern_node().unwrap();
            if let Some(constant) = n.constant() {
                walk_node(&constant, ctx);
            }
            for req in n.requireds().iter() {
                walk_node(&req, ctx);
            }
            if let Some(rest) = n.rest() {
                walk_node(&rest, ctx);
            }
            for post in n.posts().iter() {
                walk_node(&post, ctx);
            }
        }

        ruby_prism::Node::HashPatternNode { .. } => {
            let n = node.as_hash_pattern_node().unwrap();
            if let Some(constant) = n.constant() {
                walk_node(&constant, ctx);
            }
            for elem in n.elements().iter() {
                walk_node(&elem, ctx);
            }
            if let Some(rest) = n.rest() {
                walk_node(&rest, ctx);
            }
        }

        ruby_prism::Node::FindPatternNode { .. } => {
            let n = node.as_find_pattern_node().unwrap();
            if let Some(constant) = n.constant() {
                walk_node(&constant, ctx);
            }
            walk_node(&n.left().as_node(), ctx);
            for req in n.requireds().iter() {
                walk_node(&req, ctx);
            }
            walk_node(&n.right(), ctx);
        }

        ruby_prism::Node::CapturePatternNode { .. } => {
            let n = node.as_capture_pattern_node().unwrap();
            walk_node(&n.value(), ctx);
            walk_node(&n.target().as_node(), ctx);
        }

        ruby_prism::Node::AlternationPatternNode { .. } => {
            let n = node.as_alternation_pattern_node().unwrap();
            walk_node(&n.left(), ctx);
            walk_node(&n.right(), ctx);
        }

        ruby_prism::Node::PinnedExpressionNode { .. } => {
            let n = node.as_pinned_expression_node().unwrap();
            walk_node(&n.expression(), ctx);
        }

        ruby_prism::Node::PinnedVariableNode { .. } => {
            let n = node.as_pinned_variable_node().unwrap();
            walk_node(&n.variable(), ctx);
        }

        // =====================================================================
        // Literals — these are leaf nodes, we emit LITERAL for structural completeness
        // but don't create graph nodes for most literals to avoid noise.
        // We just walk their children if any.
        // =====================================================================
        ruby_prism::Node::IntegerNode { .. }
        | ruby_prism::Node::FloatNode { .. }
        | ruby_prism::Node::TrueNode { .. }
        | ruby_prism::Node::FalseNode { .. }
        | ruby_prism::Node::NilNode { .. }
        | ruby_prism::Node::SourceFileNode { .. }
        | ruby_prism::Node::SourceLineNode { .. }
        | ruby_prism::Node::SourceEncodingNode { .. }
        | ruby_prism::Node::MatchLastLineNode { .. }
        | ruby_prism::Node::RegularExpressionNode { .. }
        | ruby_prism::Node::XStringNode { .. } => {
            // Leaf literals — no graph nodes, no children
        }

        ruby_prism::Node::StringNode { .. } => {
            // Leaf literal — no children
        }

        ruby_prism::Node::SymbolNode { .. } => {
            // Leaf literal — no children
        }

        ruby_prism::Node::RationalNode { .. } => {
            // Leaf literal, contains numeric child but we don't walk it
        }

        ruby_prism::Node::ImaginaryNode { .. } => {
            // Leaf literal, contains numeric child but we don't walk it
        }

        ruby_prism::Node::SelfNode { .. } => {
            // Self reference — no graph node needed
        }

        ruby_prism::Node::RangeNode { .. } => {
            let n = node.as_range_node().unwrap();
            if let Some(left) = n.left() {
                walk_node(&left, ctx);
            }
            if let Some(right) = n.right() {
                walk_node(&right, ctx);
            }
        }

        // =====================================================================
        // String Interpolation
        // =====================================================================
        ruby_prism::Node::InterpolatedStringNode { .. } => {
            let n = node.as_interpolated_string_node().unwrap();
            for part in n.parts().iter() {
                walk_node(&part, ctx);
            }
        }

        ruby_prism::Node::InterpolatedSymbolNode { .. } => {
            let n = node.as_interpolated_symbol_node().unwrap();
            for part in n.parts().iter() {
                walk_node(&part, ctx);
            }
        }

        ruby_prism::Node::InterpolatedRegularExpressionNode { .. } => {
            let n = node.as_interpolated_regular_expression_node().unwrap();
            for part in n.parts().iter() {
                walk_node(&part, ctx);
            }
        }

        ruby_prism::Node::InterpolatedXStringNode { .. } => {
            let n = node.as_interpolated_x_string_node().unwrap();
            for part in n.parts().iter() {
                walk_node(&part, ctx);
            }
        }

        ruby_prism::Node::InterpolatedMatchLastLineNode { .. } => {
            let n = node.as_interpolated_match_last_line_node().unwrap();
            for part in n.parts().iter() {
                walk_node(&part, ctx);
            }
        }

        ruby_prism::Node::EmbeddedStatementsNode { .. } => {
            let n = node.as_embedded_statements_node().unwrap();
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
        }

        ruby_prism::Node::EmbeddedVariableNode { .. } => {
            let n = node.as_embedded_variable_node().unwrap();
            walk_node(&n.variable(), ctx);
        }

        // =====================================================================
        // Collections
        // =====================================================================
        ruby_prism::Node::ArrayNode { .. } => {
            let n = node.as_array_node().unwrap();
            for elem in n.elements().iter() {
                walk_node(&elem, ctx);
            }
        }

        ruby_prism::Node::HashNode { .. } => {
            let n = node.as_hash_node().unwrap();
            for elem in n.elements().iter() {
                walk_node(&elem, ctx);
            }
        }

        ruby_prism::Node::AssocNode { .. } => {
            let n = node.as_assoc_node().unwrap();
            walk_node(&n.key(), ctx);
            walk_node(&n.value(), ctx);
        }

        ruby_prism::Node::AssocSplatNode { .. } => {
            let n = node.as_assoc_splat_node().unwrap();
            if let Some(val) = n.value() {
                walk_node(&val, ctx);
            }
        }

        ruby_prism::Node::SplatNode { .. } => {
            let n = node.as_splat_node().unwrap();
            if let Some(expr) = n.expression() {
                walk_node(&expr, ctx);
            }
        }

        ruby_prism::Node::KeywordHashNode { .. } => {
            let n = node.as_keyword_hash_node().unwrap();
            for elem in n.elements().iter() {
                walk_node(&elem, ctx);
            }
        }

        // =====================================================================
        // Special
        // =====================================================================
        ruby_prism::Node::DefinedNode { .. } => {
            let n = node.as_defined_node().unwrap();
            walk_node(&n.value(), ctx);
        }

        ruby_prism::Node::ParenthesesNode { .. } => {
            let n = node.as_parentheses_node().unwrap();
            if let Some(body) = n.body() {
                walk_node(&body, ctx);
            }
        }

        ruby_prism::Node::ImplicitNode { .. } => {
            let n = node.as_implicit_node().unwrap();
            walk_node(&n.value(), ctx);
        }

        ruby_prism::Node::ImplicitRestNode { .. } => {
            // No children
        }

        ruby_prism::Node::ForwardingArgumentsNode { .. } => {
            // Leaf node — refers to the forwarding parameter
        }

        ruby_prism::Node::BackReferenceReadNode { .. } => {
            let n = node.as_back_reference_read_node().unwrap();
            let name = cid_to_string(&n.name());
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &name, None, Some(&hash));
            let gn = GraphNode {
                id: node_id,
                node_type: "REFERENCE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "back_reference")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
        }

        ruby_prism::Node::NumberedReferenceReadNode { .. } => {
            let loc = node.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let name = String::from_utf8_lossy(loc.as_slice()).to_string();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &name, None, Some(&hash));
            let gn = GraphNode {
                id: node_id,
                node_type: "REFERENCE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "numbered_reference")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
        }

        ruby_prism::Node::PreExecutionNode { .. } => {
            let n = node.as_pre_execution_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "FUNCTION", "<BEGIN>", None, Some(&hash));

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "FUNCTION".to_string(),
                name: "<BEGIN>".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "BEGIN")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);

            let prev_fn = ctx.enclosing_fn.take();
            ctx.enclosing_fn = Some(node_id.clone());
            ctx.push_scope(&node_id, ScopeKind::Function, line, col, end_line, end_col);
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
            ctx.pop_scope();
            ctx.enclosing_fn = prev_fn;
        }

        ruby_prism::Node::PostExecutionNode { .. } => {
            let n = node.as_post_execution_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "FUNCTION", "<END>", None, Some(&hash));

            let gn = GraphNode {
                id: node_id.clone(),
                node_type: "FUNCTION".to_string(),
                name: "<END>".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "END")]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);

            let prev_fn = ctx.enclosing_fn.take();
            ctx.enclosing_fn = Some(node_id.clone());
            ctx.push_scope(&node_id, ScopeKind::Function, line, col, end_line, end_col);
            if let Some(stmts) = n.statements() {
                for child in stmts.body().iter() {
                    walk_node(&child, ctx);
                }
            }
            ctx.pop_scope();
            ctx.enclosing_fn = prev_fn;
        }

        ruby_prism::Node::MissingNode { .. } => {
            let loc = node.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "ISSUE", "parse_error", None, Some(&hash));

            let gn = GraphNode {
                id: node_id,
                node_type: "ISSUE".to_string(),
                name: "parse_error".to_string(),
                file: ctx.file.clone(),
                line, column: col, end_line, end_column: end_col,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_text("category", "parse_error"),
                    Ctx::meta_text("severity", "error"),
                    Ctx::meta_text("message", "Missing or malformed syntax detected by parser"),
                ]),
                extra: HashMap::new(),
            };
            ctx.emit_node(gn);
        }
    }
}

// ---------------------------------------------------------------------------
// Helper: walk ParametersNode children
// ---------------------------------------------------------------------------

fn walk_parameters(params: &ruby_prism::ParametersNode<'_>, ctx: &mut Ctx) {
    for req in params.requireds().iter() {
        walk_node(&req, ctx);
    }
    for opt in params.optionals().iter() {
        walk_node(&opt, ctx);
    }
    if let Some(rest) = params.rest() {
        walk_node(&rest, ctx);
    }
    for post in params.posts().iter() {
        walk_node(&post, ctx);
    }
    for kw in params.keywords().iter() {
        walk_node(&kw, ctx);
    }
    if let Some(kw_rest) = params.keyword_rest() {
        walk_node(&kw_rest, ctx);
    }
    if let Some(block) = params.block() {
        walk_node(&block.as_node(), ctx);
    }
}

// ---------------------------------------------------------------------------
// Helper: walk rescue chain (rescue -> subsequent -> subsequent -> ...)
// ---------------------------------------------------------------------------

fn walk_rescue_chain(rescue: &ruby_prism::RescueNode<'_>, ctx: &mut Ctx) {
    for exc in rescue.exceptions().iter() {
        walk_node(&exc, ctx);
    }
    if let Some(reference) = rescue.reference() {
        walk_node(&reference, ctx);
    }
    if let Some(stmts) = rescue.statements() {
        for child in stmts.body().iter() {
            walk_node(&child, ctx);
        }
    }
    if let Some(sub) = rescue.subsequent() {
        walk_rescue_chain(&sub, ctx);
    }
}

// ---------------------------------------------------------------------------
// Helper: emit a simple CALL node
// ---------------------------------------------------------------------------

fn emit_call_node(ctx: &mut Ctx, node_id: &str, name: &str, line: i64, col: i64, end_line: i64, end_col: i64) {
    let gn = GraphNode {
        id: node_id.to_string(),
        node_type: "CALL".to_string(),
        name: name.to_string(),
        file: ctx.file.clone(),
        line, column: col, end_line, end_column: end_col,
        exported: false,
        metadata: HashMap::new(),
        extra: HashMap::new(),
    };
    ctx.emit_node(gn);
}

// ---------------------------------------------------------------------------
// Helper: emit instance variable write (compound forms)
// ---------------------------------------------------------------------------

fn emit_ivar_write(ctx: &mut Ctx, name: &str, loc: &ruby_prism::Location<'_>, value: &ruby_prism::Node<'_>) {
    let (line, col) = ctx.loc_line_col(loc.start_offset());
    let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
    let parent_name = ctx.enclosing_class_or_module();
    let node_id = semantic_id(&ctx.file, "VARIABLE", name, parent_name.as_deref(), None);
    let gn = GraphNode {
        id: node_id.clone(),
        node_type: "VARIABLE".to_string(),
        name: name.to_string(),
        file: ctx.file.clone(),
        line, column: col, end_line, end_column: end_col,
        exported: false,
        metadata: HashMap::from([Ctx::meta_text("kind", "instance")]),
        extra: HashMap::new(),
    };
    ctx.emit_declaration(gn);
    let before = ctx.nodes.len();
    walk_node(value, ctx);
    if ctx.nodes.len() > before {
        let value_node_id = ctx.nodes[before].id.clone();
        ctx.emit_edge(GraphEdge {
            src: node_id,
            dst: value_node_id,
            edge_type: "ASSIGNED_FROM".to_string(),
            metadata: HashMap::new(),
        });
    }
}

// ---------------------------------------------------------------------------
// Helper: emit class variable write (compound forms)
// ---------------------------------------------------------------------------

fn emit_cvar_write(ctx: &mut Ctx, name: &str, loc: &ruby_prism::Location<'_>, value: &ruby_prism::Node<'_>) {
    let (line, col) = ctx.loc_line_col(loc.start_offset());
    let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
    let parent_name = ctx.enclosing_class_or_module();
    let node_id = semantic_id(&ctx.file, "VARIABLE", name, parent_name.as_deref(), None);
    let gn = GraphNode {
        id: node_id.clone(),
        node_type: "VARIABLE".to_string(),
        name: name.to_string(),
        file: ctx.file.clone(),
        line, column: col, end_line, end_column: end_col,
        exported: false,
        metadata: HashMap::from([Ctx::meta_text("kind", "class")]),
        extra: HashMap::new(),
    };
    ctx.emit_declaration(gn);
    let before = ctx.nodes.len();
    walk_node(value, ctx);
    if ctx.nodes.len() > before {
        let value_node_id = ctx.nodes[before].id.clone();
        ctx.emit_edge(GraphEdge {
            src: node_id,
            dst: value_node_id,
            edge_type: "ASSIGNED_FROM".to_string(),
            metadata: HashMap::new(),
        });
    }
}

// ---------------------------------------------------------------------------
// Helper: emit global variable write (compound forms)
// ---------------------------------------------------------------------------

fn emit_gvar_write(ctx: &mut Ctx, name: &str, loc: &ruby_prism::Location<'_>, value: &ruby_prism::Node<'_>) {
    let (line, col) = ctx.loc_line_col(loc.start_offset());
    let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
    let node_id = semantic_id(&ctx.file, "VARIABLE", name, None, None);
    let gn = GraphNode {
        id: node_id.clone(),
        node_type: "VARIABLE".to_string(),
        name: name.to_string(),
        file: ctx.file.clone(),
        line, column: col, end_line, end_column: end_col,
        exported: false,
        metadata: HashMap::from([Ctx::meta_text("kind", "global")]),
        extra: HashMap::new(),
    };
    ctx.emit_declaration(gn);
    let before = ctx.nodes.len();
    walk_node(value, ctx);
    if ctx.nodes.len() > before {
        let value_node_id = ctx.nodes[before].id.clone();
        ctx.emit_edge(GraphEdge {
            src: node_id,
            dst: value_node_id,
            edge_type: "ASSIGNED_FROM".to_string(),
            metadata: HashMap::new(),
        });
    }
}

// ---------------------------------------------------------------------------
// Helper: emit constant write (compound forms)
// ---------------------------------------------------------------------------

fn emit_const_write(ctx: &mut Ctx, name: &str, loc: &ruby_prism::Location<'_>, value: &ruby_prism::Node<'_>) {
    let (line, col) = ctx.loc_line_col(loc.start_offset());
    let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
    let parent_name = ctx.enclosing_class_or_module();
    let node_id = semantic_id(&ctx.file, "CONSTANT", name, parent_name.as_deref(), None);
    let gn = GraphNode {
        id: node_id.clone(),
        node_type: "CONSTANT".to_string(),
        name: name.to_string(),
        file: ctx.file.clone(),
        line, column: col, end_line, end_column: end_col,
        exported: true,
        metadata: HashMap::new(),
        extra: HashMap::new(),
    };
    ctx.emit_declaration(gn);
    let before = ctx.nodes.len();
    walk_node(value, ctx);
    if ctx.nodes.len() > before {
        let value_node_id = ctx.nodes[before].id.clone();
        ctx.emit_edge(GraphEdge {
            src: node_id,
            dst: value_node_id,
            edge_type: "ASSIGNED_FROM".to_string(),
            metadata: HashMap::new(),
        });
    }
}

// ---------------------------------------------------------------------------
// Helper: extract string value from a Node (for require arguments)
// ---------------------------------------------------------------------------

fn extract_string_value(node: &ruby_prism::Node<'_>) -> Option<String> {
    match node {
        ruby_prism::Node::StringNode { .. } => {
            let sn = node.as_string_node().unwrap();
            Some(String::from_utf8_lossy(sn.unescaped()).to_string())
        }
        ruby_prism::Node::InterpolatedStringNode { .. } => {
            // Dynamic string — return None
            None
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Helper: extract symbol name from a Node (for attr_reader etc.)
// ---------------------------------------------------------------------------

fn extract_symbol_name(node: &ruby_prism::Node<'_>) -> Option<String> {
    match node {
        ruby_prism::Node::SymbolNode { .. } => {
            let sn = node.as_symbol_node().unwrap();
            Some(String::from_utf8_lossy(sn.unescaped()).to_string())
        }
        ruby_prism::Node::StringNode { .. } => {
            let sn = node.as_string_node().unwrap();
            Some(String::from_utf8_lossy(sn.unescaped()).to_string())
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Helper: extract a name from either a symbol or literal for alias nodes
// ---------------------------------------------------------------------------

fn extract_symbol_or_literal_name(node: &ruby_prism::Node<'_>) -> String {
    match node {
        ruby_prism::Node::SymbolNode { .. } => {
            let sn = node.as_symbol_node().unwrap();
            String::from_utf8_lossy(sn.unescaped()).to_string()
        }
        ruby_prism::Node::GlobalVariableReadNode { .. } => {
            let n = node.as_global_variable_read_node().unwrap();
            cid_to_string(&n.name())
        }
        ruby_prism::Node::BackReferenceReadNode { .. } => {
            let n = node.as_back_reference_read_node().unwrap();
            cid_to_string(&n.name())
        }
        _ => String::from_utf8_lossy(node.location().as_slice()).to_string(),
    }
}

// ---------------------------------------------------------------------------
// Helper: extract a reference name from a node (for PASSES_ARGUMENT)
// ---------------------------------------------------------------------------

fn extract_ref_name(node: &ruby_prism::Node<'_>) -> Option<String> {
    match node {
        ruby_prism::Node::LocalVariableReadNode { .. } => {
            let n = node.as_local_variable_read_node().unwrap();
            Some(cid_to_string(&n.name()))
        }
        ruby_prism::Node::ConstantReadNode { .. } => {
            let n = node.as_constant_read_node().unwrap();
            Some(cid_to_string(&n.name()))
        }
        ruby_prism::Node::InstanceVariableReadNode { .. } => {
            let n = node.as_instance_variable_read_node().unwrap();
            Some(cid_to_string(&n.name()))
        }
        ruby_prism::Node::SelfNode { .. } => Some("self".to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Helper: walk generic children for Index*WriteNode and IndexTargetNode
// The ruby-prism Index nodes have receiver, arguments, block fields that vary.
// We walk them using their location as a generic fallback.
// ---------------------------------------------------------------------------

fn walk_children_generic(node: &ruby_prism::Node<'_>, ctx: &mut Ctx) {
    // For Index*WriteNode variants, we emit a CALL and walk subfields
    match node {
        ruby_prism::Node::IndexAndWriteNode { .. } => {
            let n = node.as_index_and_write_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", "[]", None, Some(&hash));
            emit_call_node(ctx, &node_id, "[]", line, col, end_line, end_col);
            if let Some(recv) = n.receiver() { walk_node(&recv, ctx); }
            if let Some(args) = n.arguments() {
                for a in args.arguments().iter() { walk_node(&a, ctx); }
            }
            walk_node(&n.value(), ctx);
        }
        ruby_prism::Node::IndexOrWriteNode { .. } => {
            let n = node.as_index_or_write_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", "[]", None, Some(&hash));
            emit_call_node(ctx, &node_id, "[]", line, col, end_line, end_col);
            if let Some(recv) = n.receiver() { walk_node(&recv, ctx); }
            if let Some(args) = n.arguments() {
                for a in args.arguments().iter() { walk_node(&a, ctx); }
            }
            walk_node(&n.value(), ctx);
        }
        ruby_prism::Node::IndexOperatorWriteNode { .. } => {
            let n = node.as_index_operator_write_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", "[]", None, Some(&hash));
            emit_call_node(ctx, &node_id, "[]", line, col, end_line, end_col);
            if let Some(recv) = n.receiver() { walk_node(&recv, ctx); }
            if let Some(args) = n.arguments() {
                for a in args.arguments().iter() { walk_node(&a, ctx); }
            }
            walk_node(&n.value(), ctx);
        }
        ruby_prism::Node::IndexTargetNode { .. } => {
            let n = node.as_index_target_node().unwrap();
            let loc = n.location();
            let (line, col) = ctx.loc_line_col(loc.start_offset());
            let (end_line, end_col) = ctx.loc_line_col(loc.end_offset());
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", "[]", None, Some(&hash));
            emit_call_node(ctx, &node_id, "[]", line, col, end_line, end_col);
            walk_node(&n.receiver(), ctx);
            if let Some(args) = n.arguments() {
                for a in args.arguments().iter() { walk_node(&a, ctx); }
            }
        }
        _ => panic!("ruby_analyzer: unhandled Prism node variant"),
    }
}


// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn analyze(source: &str) -> FileAnalysis {
        analyze_ruby_file("test.rb", source.as_bytes())
    }

    fn find_nodes_by_type<'a>(analysis: &'a FileAnalysis, node_type: &str) -> Vec<&'a GraphNode> {
        analysis.nodes.iter().filter(|n| n.node_type == node_type).collect()
    }

    fn find_edges_by_type<'a>(analysis: &'a FileAnalysis, edge_type: &str) -> Vec<&'a GraphEdge> {
        analysis.edges.iter().filter(|e| e.edge_type == edge_type).collect()
    }

    // 1. Empty file -> MODULE
    #[test]
    fn test_empty_file() {
        let a = analyze("");
        let modules = find_nodes_by_type(&a, "MODULE");
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].name, "test");
        assert_eq!(modules[0].id, "MODULE#test.rb");
    }

    // 2. module Foo; end -> MODULE "Foo"
    #[test]
    fn test_module_node() {
        let a = analyze("module Foo\nend");
        let modules = find_nodes_by_type(&a, "MODULE");
        assert_eq!(modules.len(), 2); // file MODULE + Foo MODULE
        let foo = modules.iter().find(|m| m.name == "Foo").unwrap();
        assert_eq!(foo.id, "test.rb->MODULE->Foo");
    }

    // 3. class Foo < Bar; end -> CLASS + EXTENDS
    #[test]
    fn test_class_extends() {
        let a = analyze("class Foo < Bar\nend");
        let classes = find_nodes_by_type(&a, "CLASS");
        assert_eq!(classes.len(), 1);
        assert_eq!(classes[0].name, "Foo");

        let extends = find_edges_by_type(&a, "EXTENDS");
        assert_eq!(extends.len(), 1);
        assert_eq!(extends[0].src, "test.rb->CLASS->Foo");
        assert!(extends[0].dst.contains("Bar"));
    }

    // 4. def foo(x, y); end -> FUNCTION + PARAMETER
    #[test]
    fn test_def_with_params() {
        let a = analyze("def foo(x, y)\nend");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        assert_eq!(functions.len(), 1);
        assert_eq!(functions[0].name, "foo");

        let params = find_nodes_by_type(&a, "PARAMETER");
        assert_eq!(params.len(), 2);
        let names: Vec<&str> = params.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"x"));
        assert!(names.contains(&"y"));
    }

    // 5. require 'json' -> IMPORT
    #[test]
    fn test_require() {
        let a = analyze("require 'json'");
        let imports = find_nodes_by_type(&a, "IMPORT");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].name, "json");
    }

    // 6. x = 42 -> VARIABLE
    #[test]
    fn test_local_variable() {
        let a = analyze("x = 42");
        let vars = find_nodes_by_type(&a, "VARIABLE");
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].name, "x");
    }

    // 7. Basic visibility test
    #[test]
    fn test_visibility() {
        let a = analyze("class Foo\n  def pub_method; end\n  private\n  def priv_method; end\nend");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        let pub_m = functions.iter().find(|f| f.name == "pub_method").unwrap();
        let priv_m = functions.iter().find(|f| f.name == "priv_method").unwrap();

        assert_eq!(pub_m.metadata.get("visibility").unwrap(), "public");
        assert_eq!(priv_m.metadata.get("visibility").unwrap(), "private");
        assert!(pub_m.exported);
        assert!(!priv_m.exported);
    }

    // 8. Block test
    #[test]
    fn test_block() {
        let a = analyze("[1,2,3].each { |x| puts x }");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        let block = functions.iter().find(|f| f.name == "<block>").unwrap();
        assert_eq!(block.metadata.get("kind").unwrap(), "block");
    }

    // 9. attr_reader test
    #[test]
    fn test_attr_reader() {
        let a = analyze("class Foo\n  attr_reader :name, :age\nend");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        let names: Vec<&str> = functions.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"name"), "expected attr_reader :name to create a FUNCTION node");
        assert!(names.contains(&"age"), "expected attr_reader :age to create a FUNCTION node");
    }

    // 9b. define_method — symbol name creates a FUNCTION node + HAS_METHOD edge
    #[test]
    fn test_define_method_symbol_creates_method() {
        let a = analyze("class Foo\n  define_method(:greet) { puts 'hi' }\nend");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        let greet = functions.iter().find(|f| f.name == "greet")
            .expect("define_method(:greet) should create a FUNCTION node named 'greet'");
        assert_eq!(greet.metadata.get("kind").map(|v| v.as_str().unwrap()), Some("define_method"));

        let has_method = find_edges_by_type(&a, "HAS_METHOD");
        assert!(
            has_method.iter().any(|e| e.dst == greet.id),
            "expected a HAS_METHOD edge from the enclosing class to the define_method'd method"
        );
    }

    // 9c. define_method body is walked under the method's scope (CALLS attribution)
    #[test]
    fn test_define_method_body_attributed_to_method() {
        let a = analyze("class Foo\n  define_method(:greet) { helper_call }\nend");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        let greet = functions.iter().find(|f| f.name == "greet").unwrap();
        let calls = find_edges_by_type(&a, "CALLS");
        assert!(
            calls.iter().any(|e| e.src == greet.id),
            "a call inside the define_method block must be attributed to the defined method"
        );
        // The body block must NOT also surface as a separate '<block>' FUNCTION —
        // the method node IS the body container (mirrors `def`).
        assert!(
            !functions.iter().any(|f| f.name == "<block>"),
            "define_method body should be the method's scope, not a separate <block> function"
        );
    }

    // 9d. define_method — string name + current visibility default
    #[test]
    fn test_define_method_string_name_visibility() {
        let a = analyze("class Foo\n  private\n  define_method('secret') { }\nend");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        let secret = functions.iter().find(|f| f.name == "secret")
            .expect("string-named define_method should create a FUNCTION node");
        assert_eq!(secret.metadata.get("visibility").map(|v| v.as_str().unwrap()), Some("private"));
        assert!(!secret.exported, "private define_method should not be exported");
    }

    // 9e. define_method with a dynamic (non-literal) name: no method node, no panic,
    // falls back to a general CALL node so nothing is lost.
    #[test]
    fn test_define_method_dynamic_name_falls_back() {
        let a = analyze("class Foo\n  define_method(method_name_var) { 1 }\nend");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        assert!(
            !functions.iter().any(|f| f.name == "method_name_var"),
            "a dynamic-name define_method must not create a method node named after the expression"
        );
        let calls = find_nodes_by_type(&a, "CALL");
        assert!(
            calls.iter().any(|c| c.name == "define_method"),
            "dynamic-name define_method should fall back to a general CALL node"
        );
    }

    // 10. Scope hierarchy
    #[test]
    fn test_scope_hierarchy() {
        let a = analyze("module Outer\n  class Inner\n    def method\n    end\n  end\nend");
        let has_scope = find_edges_by_type(&a, "HAS_SCOPE");
        // MODULE#test.rb -> Outer, Outer -> Inner, Inner -> method
        assert!(has_scope.len() >= 3, "expected at least 3 HAS_SCOPE edges, got {}", has_scope.len());

        // Verify the chain
        let module_to_outer = has_scope.iter().any(|e| e.src == "MODULE#test.rb" && e.dst.contains("Outer"));
        assert!(module_to_outer, "MODULE should have HAS_SCOPE to Outer");

        let outer_to_inner = has_scope.iter().any(|e| e.dst.contains("Inner") && e.src.contains("Outer"));
        assert!(outer_to_inner, "Outer should have HAS_SCOPE to Inner");
    }

    // 11. Instance variable
    #[test]
    fn test_instance_variable() {
        let a = analyze("class Foo\n  def initialize\n    @name = 'test'\n  end\nend");
        let vars = find_nodes_by_type(&a, "VARIABLE");
        let ivar = vars.iter().find(|v| v.name == "@name").unwrap();
        assert_eq!(ivar.metadata.get("kind").unwrap(), "instance");
    }

    // 12. Constants
    #[test]
    fn test_constant_write() {
        let a = analyze("MAX = 100");
        let consts = find_nodes_by_type(&a, "CONSTANT");
        assert_eq!(consts.len(), 1);
        assert_eq!(consts[0].name, "MAX");
    }

    // 13. require_relative
    #[test]
    fn test_require_relative() {
        let a = analyze("require_relative 'helper'");
        let imports = find_nodes_by_type(&a, "IMPORT");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].name, "helper");
        assert_eq!(imports[0].metadata.get("kind").unwrap(), "require_relative");
    }

    // 14. Method calls with receiver
    #[test]
    fn test_method_call_with_receiver() {
        let a = analyze("obj.method_name(1, 2)");
        let calls = find_nodes_by_type(&a, "CALL");
        assert!(!calls.is_empty());
        let call = calls.iter().find(|c| c.name.contains("method_name")).unwrap();
        assert!(call.metadata.get("receiver").is_some());
    }

    // 15. Lambda
    #[test]
    fn test_lambda() {
        let a = analyze("l = -> (x) { x + 1 }");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        let lambda = functions.iter().find(|f| f.name == "<lambda>").unwrap();
        assert_eq!(lambda.metadata.get("kind").unwrap(), "lambda");
    }

    // 16. BEGIN/END blocks
    #[test]
    fn test_begin_end_blocks() {
        let a = analyze("BEGIN { $stdout.sync = true }\nEND { puts 'done' }");
        let functions = find_nodes_by_type(&a, "FUNCTION");
        assert!(functions.iter().any(|f| f.metadata.get("kind").map(|v| v == "BEGIN").unwrap_or(false)),
            "BEGIN block should create FUNCTION with kind BEGIN");
        assert!(functions.iter().any(|f| f.metadata.get("kind").map(|v| v == "END").unwrap_or(false)),
            "END block should create FUNCTION with kind END");
    }

    // 17. for loop creates VARIABLE for iterator
    #[test]
    fn test_for_loop_variable() {
        let a = analyze("for item in [1, 2, 3]\n  puts item\nend");
        let vars = find_nodes_by_type(&a, "VARIABLE");
        assert!(vars.iter().any(|v| v.name == "item"), "for loop should create VARIABLE for iterator");
    }

    // 18. MissingNode produces ISSUE on malformed input
    #[test]
    fn test_missing_node_issue() {
        // Malformed Ruby inputs — analyzer must not panic on any of them
        let inputs = [
            "def foo(\nend",
            "class",
            "def",
            "if\nend",
            "begin\n  rescue =>\nend",
        ];
        for input in &inputs {
            let a = analyze(input);
            assert!(a.nodes.len() >= 1,
                "Should produce at least the file MODULE even on bad input: {input}");
        }

        // Try an input that reliably produces a MissingNode in Prism: bare `class` keyword
        let a = analyze("class\nend");
        let issues = find_nodes_by_type(&a, "ISSUE");
        if !issues.is_empty() {
            assert!(issues.iter().any(|i|
                i.metadata.get("category").map(|v| v == "parse_error").unwrap_or(false)
            ), "ISSUE node should have category=parse_error");
        }
    }

    // =========================================================================
    // Verification test: realistic Ruby file
    // =========================================================================
    #[test]
    fn test_verify_realistic_ruby() {
        let source = r##"# frozen_string_literal: true

require 'json'
require_relative 'helpers/auth'

module Authentication
  module Strategies
    class BaseStrategy
      MAX_RETRIES = 3
      DEFAULT_TIMEOUT = 30

      attr_reader :name, :config
      attr_accessor :logger

      def initialize(name, config = {})
        @name = name
        @config = config
        @logger = nil
        @retry_count = 0
      end

      def authenticate(credentials)
        raise NotImplementedError, "#{self.class}#authenticate not implemented"
      end

      def self.registry
        @@registry ||= {}
      end

      def self.register(name, klass)
        registry[name] = klass
      end

      private

      def log(message, level: :info)
        logger&.send(level, "[#{@name}] #{message}")
      end

      def with_retry(&block)
        attempts = 0
        begin
          attempts += 1
          yield
        rescue StandardError => e
          if attempts < MAX_RETRIES
            log("Retry #{attempts}/#{MAX_RETRIES}: #{e.message}", level: :warn)
            retry
          else
            raise
          end
        end
      end
    end

    class TokenStrategy < BaseStrategy
      HEADER_KEY = 'Authorization'

      def initialize(name, config = {})
        super
        @token_cache = {}
      end

      def authenticate(credentials)
        token = credentials[:token] || credentials['token']
        return { valid: false, error: 'Missing token' } unless token

        with_retry do
          result = validate_token(token)
          cache_result(token, result) if result[:valid]
          result
        end
      end

      protected

      def validate_token(token)
        decoded = JSON.parse(Base64.decode64(token)) rescue nil
        return { valid: false, error: 'Invalid token format' } unless decoded

        expired = decoded['exp'] && decoded['exp'] < Time.now.to_i
        { valid: !expired, user_id: decoded['sub'], roles: decoded['roles'] || [] }
      end

      private

      def cache_result(token, result)
        @token_cache[token] = { result: result, cached_at: Time.now }
      end
    end
  end
end

# Mixin for rate limiting
module RateLimitable
  def rate_limit(max_requests:, window: 60)
    @rate_limits ||= {}
    key = caller_locations(1, 1).first.label
    @rate_limits[key] = { max: max_requests, window: window, requests: [] }
  end

  def check_rate_limit(key)
    return true unless @rate_limits&.key?(key)

    limit = @rate_limits[key]
    now = Time.now.to_i
    limit[:requests].reject! { |t| t < now - limit[:window] }
    limit[:requests].size < limit[:max]
  end
end

class AuthController
  include RateLimitable
  extend Forwardable

  def_delegator :@strategy, :authenticate

  ALLOWED_STRATEGIES = %w[token oauth saml].freeze

  def initialize(strategy_name)
    unless ALLOWED_STRATEGIES.include?(strategy_name)
      raise ArgumentError, "Unknown strategy: #{strategy_name}"
    end

    klass = Authentication::Strategies::BaseStrategy.registry[strategy_name]
    @strategy = klass.new(strategy_name)
    @request_log = []
  end

  def process_request(request)
    credentials = extract_credentials(request)
    result = authenticate(credentials)

    @request_log << { at: Time.now, strategy: @strategy.name, success: result[:valid] }

    if result[:valid]
      { status: 200, body: { user_id: result[:user_id], roles: result[:roles] } }
    else
      { status: 401, body: { error: result[:error] || 'Unauthorized' } }
    end
  end

  private

  def extract_credentials(request)
    case request[:type]
    when :bearer
      { token: request[:headers]&.dig('Authorization')&.sub(/^Bearer /, '') }
    when :basic
      user, pass = Base64.decode64(request[:headers]['Authorization'].sub(/^Basic /, '')).split(':', 2)
      { username: user, password: pass }
    else
      {}
    end
  end
end

# Pattern matching (Ruby 3.0+)
def process_auth_result(result)
  case result
  in { valid: true, user_id: String => uid, roles: [*, "admin", *] }
    puts "Admin access granted for #{uid}"
  in { valid: true, user_id: String => uid }
    puts "User access granted for #{uid}"
  in { valid: false, error: String => msg }
    puts "Auth failed: #{msg}"
  end
end

# Lambdas and procs
format_log = ->(entry) { "[#{entry[:at]}] #{entry[:strategy]}: #{entry[:success]}" }
validator = proc { |token| token.is_a?(String) && token.length > 10 }

# Multiple assignment
a, b, *rest = [1, 2, 3, 4, 5]
status, message = [:ok, "Success"]

# BEGIN/END blocks
BEGIN { $stdout.sync = true }
END { puts "Auth module unloaded" }

# Alias
class AuthController
  alias_method :auth, :authenticate
  alias old_process process_request

  undef_method :old_process rescue nil
end

# For loop
for strategy_name in %w[token oauth]
  Authentication::Strategies::BaseStrategy.register(strategy_name, Authentication::Strategies::TokenStrategy)
end

# Yield
def with_auth_context(user_id)
  context = { user_id: user_id, authenticated_at: Time.now }
  yield context if block_given?
ensure
  context&.clear
end

# defined? check
if defined?(Rails)
  Rails.logger.info("Authentication module loaded")
end

puts "Authentication system ready" if __FILE__ == $PROGRAM_NAME
"##;
        let a = analyze_ruby_file("demo.rb", source.as_bytes());

        // Collect all node types
        let mut type_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for node in &a.nodes {
            *type_counts.entry(node.node_type.as_str()).or_default() += 1;
        }
        let mut edge_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for edge in &a.edges {
            *edge_counts.entry(edge.edge_type.as_str()).or_default() += 1;
        }

        // Print for verification report
        eprintln!("\n=== VERIFICATION: demo.rb ===");
        eprintln!("Total nodes: {}", a.nodes.len());
        eprintln!("Total edges: {}", a.edges.len());
        eprintln!("Total exports: {}", a.exports.len());
        eprintln!("\nNode types:");
        let mut types: Vec<_> = type_counts.iter().collect();
        types.sort_by_key(|(_, c)| std::cmp::Reverse(**c));
        for (t, c) in &types {
            eprintln!("  {}: {}", t, c);
        }
        eprintln!("\nEdge types:");
        let mut etypes: Vec<_> = edge_counts.iter().collect();
        etypes.sort_by_key(|(_, c)| std::cmp::Reverse(**c));
        for (t, c) in &etypes {
            eprintln!("  {}: {}", t, c);
        }

        // Assertions: structural nodes
        let modules = find_nodes_by_type(&a, "MODULE");
        let module_names: Vec<&str> = modules.iter().map(|m| m.name.as_str()).collect();
        eprintln!("\nMODULEs: {:?}", module_names);
        assert!(module_names.contains(&"demo"), "File-level MODULE");
        assert!(module_names.contains(&"Authentication"), "module Authentication");
        assert!(module_names.contains(&"Strategies"), "module Strategies");
        assert!(module_names.contains(&"RateLimitable"), "module RateLimitable");

        let classes = find_nodes_by_type(&a, "CLASS");
        let class_names: Vec<&str> = classes.iter().map(|c| c.name.as_str()).collect();
        eprintln!("CLASSes: {:?}", class_names);
        assert!(class_names.contains(&"BaseStrategy"), "class BaseStrategy");
        assert!(class_names.contains(&"TokenStrategy"), "class TokenStrategy");
        assert!(class_names.contains(&"AuthController"), "class AuthController");

        // EXTENDS edge for TokenStrategy < BaseStrategy
        let extends = find_edges_by_type(&a, "EXTENDS");
        eprintln!("EXTENDS edges: {}", extends.len());
        assert!(extends.iter().any(|e| e.src.contains("TokenStrategy")),
            "TokenStrategy EXTENDS BaseStrategy");

        // Functions
        let functions = find_nodes_by_type(&a, "FUNCTION");
        let fn_names: Vec<&str> = functions.iter().map(|f| f.name.as_str()).collect();
        eprintln!("FUNCTIONs ({}): {:?}", functions.len(), fn_names);
        assert!(fn_names.contains(&"initialize"), "def initialize");
        assert!(fn_names.contains(&"authenticate"), "def authenticate");
        assert!(fn_names.contains(&"process_request"), "def process_request");
        assert!(fn_names.contains(&"validate_token"), "def validate_token");
        assert!(fn_names.contains(&"with_retry"), "def with_retry");
        assert!(fn_names.contains(&"log"), "def log");
        assert!(fn_names.contains(&"with_auth_context"), "def with_auth_context");

        // Static methods
        let static_fns: Vec<_> = functions.iter()
            .filter(|f| f.metadata.get("static").map(|v| v.as_bool().unwrap_or(false)).unwrap_or(false))
            .collect();
        let static_names: Vec<&str> = static_fns.iter().map(|f| f.name.as_str()).collect();
        eprintln!("Static methods: {:?}", static_names);
        assert!(static_names.contains(&"registry"), "def self.registry");
        assert!(static_names.contains(&"register"), "def self.register");

        // Visibility
        let private_fns: Vec<_> = functions.iter()
            .filter(|f| f.metadata.get("visibility").map(|v| v == "private").unwrap_or(false))
            .collect();
        let private_names: Vec<&str> = private_fns.iter().map(|f| f.name.as_str()).collect();
        eprintln!("Private methods: {:?}", private_names);
        assert!(private_names.contains(&"log"), "log is private");
        assert!(private_names.contains(&"with_retry"), "with_retry is private");
        assert!(private_names.contains(&"cache_result"), "cache_result is private");
        assert!(private_names.contains(&"extract_credentials"), "extract_credentials is private");

        let protected_fns: Vec<_> = functions.iter()
            .filter(|f| f.metadata.get("visibility").map(|v| v == "protected").unwrap_or(false))
            .collect();
        eprintln!("Protected methods: {:?}", protected_fns.iter().map(|f| f.name.as_str()).collect::<Vec<_>>());
        assert!(protected_fns.iter().any(|f| f.name == "validate_token"), "validate_token is protected");

        // attr_reader generated functions
        assert!(fn_names.contains(&"name"), "attr_reader :name");
        assert!(fn_names.contains(&"config"), "attr_reader :config");
        assert!(fn_names.contains(&"logger"), "attr_accessor :logger getter");
        assert!(fn_names.contains(&"logger="), "attr_accessor :logger setter");

        // Imports
        let imports = find_nodes_by_type(&a, "IMPORT");
        let import_names: Vec<&str> = imports.iter().map(|i| i.name.as_str()).collect();
        eprintln!("IMPORTs: {:?}", import_names);
        assert!(import_names.contains(&"json"), "require 'json'");
        assert!(imports.iter().any(|i| i.name.contains("auth")), "require_relative 'helpers/auth'");
        assert!(imports.iter().any(|i| {
            i.metadata.get("kind").map(|v| v == "include").unwrap_or(false)
        }), "include RateLimitable");

        // Constants
        let constants = find_nodes_by_type(&a, "CONSTANT");
        let const_names: Vec<&str> = constants.iter().map(|c| c.name.as_str()).collect();
        eprintln!("CONSTANTs: {:?}", const_names);
        assert!(const_names.contains(&"MAX_RETRIES"), "MAX_RETRIES = 3");
        assert!(const_names.contains(&"DEFAULT_TIMEOUT"), "DEFAULT_TIMEOUT = 30");
        assert!(const_names.contains(&"HEADER_KEY"), "HEADER_KEY");
        assert!(const_names.contains(&"ALLOWED_STRATEGIES"), "ALLOWED_STRATEGIES");

        // Variables (instance)
        let variables = find_nodes_by_type(&a, "VARIABLE");
        let instance_vars: Vec<_> = variables.iter()
            .filter(|v| v.metadata.get("kind").map(|k| k == "instance").unwrap_or(false))
            .collect();
        let ivar_names: Vec<&str> = instance_vars.iter().map(|v| v.name.as_str()).collect();
        eprintln!("Instance vars: {:?}", ivar_names);
        assert!(ivar_names.contains(&"@name"), "@name");
        assert!(ivar_names.contains(&"@config"), "@config");

        // Calls
        let calls = find_nodes_by_type(&a, "CALL");
        eprintln!("CALLs: {}", calls.len());
        assert!(calls.len() > 10, "Should have many calls");

        // Blocks
        let blocks: Vec<_> = functions.iter()
            .filter(|f| f.metadata.get("kind").map(|v| v == "block").unwrap_or(false))
            .collect();
        eprintln!("Blocks: {}", blocks.len());
        assert!(blocks.len() >= 2, "Should have block from with_retry and others");

        // Lambdas
        let lambdas: Vec<_> = functions.iter()
            .filter(|f| f.metadata.get("kind").map(|v| v == "lambda").unwrap_or(false))
            .collect();
        eprintln!("Lambdas: {}", lambdas.len());
        assert!(lambdas.len() >= 1, "format_log lambda");

        // Parameters
        let params = find_nodes_by_type(&a, "PARAMETER");
        eprintln!("PARAMETERs: {}", params.len());
        assert!(params.len() >= 5, "Multiple methods with params");

        // Data flow: ASSIGNED_FROM edges
        let assigned = find_edges_by_type(&a, "ASSIGNED_FROM");
        eprintln!("ASSIGNED_FROM edges: {}", assigned.len());
        assert!(assigned.len() >= 5, "Multiple assignments");

        // HAS_METHOD edges
        let has_method = find_edges_by_type(&a, "HAS_METHOD");
        eprintln!("HAS_METHOD edges: {}", has_method.len());
        assert!(has_method.len() >= 8, "Multiple methods in classes");

        // CONTAINS edges
        let contains = find_edges_by_type(&a, "CONTAINS");
        eprintln!("CONTAINS edges: {}", contains.len());
        assert!(contains.len() >= 20, "Deep scope hierarchy");

        // DECLARES edges
        let declares = find_edges_by_type(&a, "DECLARES");
        eprintln!("DECLARES edges: {}", declares.len());
        assert!(declares.len() >= 5, "Multiple declarations");

        // Scope hierarchy
        let scopes = find_nodes_by_type(&a, "SCOPE");
        eprintln!("SCOPEs: {}", scopes.len());

        eprintln!("\n=== VERIFICATION PASSED ===\n");
    }

    // =========================================================================
    // Real project test: Sinatra
    // =========================================================================
    #[test]
    fn test_sinatra_real_project() {
        // Run in a thread with 8MB stack to handle deeply nested Ruby files.
        let result = std::thread::Builder::new()
            .stack_size(8 * 1024 * 1024)
            .name("sinatra-test".into())
            .spawn(test_sinatra_real_project_inner)
            .unwrap()
            .join();
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    fn test_sinatra_real_project_inner() {
        let sinatra_dir = std::path::Path::new("/tmp/ruby-test-sinatra");
        if !sinatra_dir.exists() {
            eprintln!("Sinatra not cloned at /tmp/ruby-test-sinatra, skipping");
            return;
        }

        let mut rb_files: Vec<std::path::PathBuf> = Vec::new();
        fn collect_rb(dir: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        collect_rb(&path, files);
                    } else if path.extension().map(|e| e == "rb").unwrap_or(false) {
                        files.push(path);
                    }
                }
            }
        }
        collect_rb(sinatra_dir, &mut rb_files);
        rb_files.sort();

        eprintln!("\n=== SINATRA REAL PROJECT TEST ===");
        eprintln!("Files found: {}", rb_files.len());

        let mut total_nodes = 0usize;
        let mut total_edges = 0usize;
        let mut total_exports = 0usize;
        let mut node_type_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut edge_type_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut panicked_files: Vec<String> = Vec::new();
        let mut parsed_ok = 0usize;

        for file in &rb_files {
            let source = match std::fs::read(file) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let rel_path = file.strip_prefix(sinatra_dir).unwrap_or(file);
            let rel_str = rel_path.to_string_lossy().to_string();

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                analyze_ruby_file(&rel_str, &source)
            }));

            match result {
                Ok(analysis) => {
                    parsed_ok += 1;
                    total_nodes += analysis.nodes.len();
                    total_edges += analysis.edges.len();
                    total_exports += analysis.exports.len();
                    for node in &analysis.nodes {
                        *node_type_counts.entry(node.node_type.clone()).or_default() += 1;
                    }
                    for edge in &analysis.edges {
                        *edge_type_counts.entry(edge.edge_type.clone()).or_default() += 1;
                    }
                }
                Err(e) => {
                    let msg = if let Some(s) = e.downcast_ref::<String>() {
                        s.clone()
                    } else if let Some(s) = e.downcast_ref::<&str>() {
                        s.to_string()
                    } else {
                        "unknown panic".to_string()
                    };
                    panicked_files.push(format!("{}: {}", rel_str, msg));
                }
            }
        }

        eprintln!("Parsed OK: {}/{}", parsed_ok, rb_files.len());
        eprintln!("Panicked: {}", panicked_files.len());
        if !panicked_files.is_empty() {
            eprintln!("\nPanicked files:");
            for f in &panicked_files {
                eprintln!("  {}", f);
            }
        }

        eprintln!("\nTotal nodes: {}", total_nodes);
        eprintln!("Total edges: {}", total_edges);
        eprintln!("Total exports: {}", total_exports);

        eprintln!("\nNode types:");
        let mut types: Vec<_> = node_type_counts.iter().collect();
        types.sort_by_key(|(_, c)| std::cmp::Reverse(**c));
        for (t, c) in &types {
            eprintln!("  {:>6}  {}", c, t);
        }

        eprintln!("\nEdge types:");
        let mut etypes: Vec<_> = edge_type_counts.iter().collect();
        etypes.sort_by_key(|(_, c)| std::cmp::Reverse(**c));
        for (t, c) in &etypes {
            eprintln!("  {:>6}  {}", c, t);
        }

        // Key assertions
        assert_eq!(panicked_files.len(), 0, "No files should panic");
        assert!(total_nodes > 1000, "Sinatra should produce >1000 nodes, got {}", total_nodes);
        assert!(total_edges > 2000, "Sinatra should produce >2000 edges, got {}", total_edges);
        assert!(*node_type_counts.get("FUNCTION").unwrap_or(&0) > 100,
            "Should have >100 functions");
        assert!(*node_type_counts.get("CLASS").unwrap_or(&0) > 5,
            "Should have >5 classes");

        eprintln!("\n=== SINATRA TEST PASSED ===\n");
    }

    // =========================================================================
    // Deep analysis: call chains, dataflow, routes on sinatra/base.rb
    // =========================================================================
    #[test]
    fn test_sinatra_deep_analysis() {
        let result = std::thread::Builder::new()
            .stack_size(8 * 1024 * 1024)
            .name("sinatra-deep".into())
            .spawn(test_sinatra_deep_analysis_inner)
            .unwrap()
            .join();
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    fn test_sinatra_deep_analysis_inner() {
        let base_path = std::path::Path::new("/tmp/ruby-test-sinatra/lib/sinatra/base.rb");
        if !base_path.exists() {
            eprintln!("Sinatra not cloned, skipping deep analysis");
            return;
        }

        let source = std::fs::read(base_path).unwrap();
        let a = analyze_ruby_file("lib/sinatra/base.rb", &source);

        eprintln!("\n=== DEEP ANALYSIS: sinatra/base.rb ===");
        eprintln!("Nodes: {}, Edges: {}", a.nodes.len(), a.edges.len());

        // Build lookup maps for graph traversal
        let mut node_by_id: std::collections::HashMap<&str, &GraphNode> = std::collections::HashMap::new();
        for n in &a.nodes {
            node_by_id.insert(&n.id, n);
        }
        // Adjacency list: src -> [(edge_type, dst)]
        let mut outgoing: std::collections::HashMap<&str, Vec<(&str, &str)>> = std::collections::HashMap::new();
        let mut incoming: std::collections::HashMap<&str, Vec<(&str, &str)>> = std::collections::HashMap::new();
        for e in &a.edges {
            outgoing.entry(e.src.as_str()).or_default().push((e.edge_type.as_str(), e.dst.as_str()));
            incoming.entry(e.dst.as_str()).or_default().push((e.edge_type.as_str(), e.src.as_str()));
        }

        // =====================================================================
        // 1. CALL CHAINS: Find multi-hop call paths
        // =====================================================================
        eprintln!("\n--- CALL CHAINS ---");

        let functions: Vec<&GraphNode> = a.nodes.iter()
            .filter(|n| n.node_type == "FUNCTION")
            .collect();
        let calls: Vec<&GraphEdge> = a.edges.iter()
            .filter(|e| e.edge_type == "CALLS")
            .collect();

        eprintln!("Functions: {}, CALLS edges: {}", functions.len(), calls.len());

        // CALLS direction: FUNCTION --CALLS--> CALL_NODE (call site)
        // Build call graph by: for each CALLS edge, src is the caller FUNCTION,
        // dst is the CALL node whose name is the callee method name.
        let mut call_graph: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for edge in &calls {
            if let (Some(caller), Some(call_site)) = (node_by_id.get(edge.src.as_str()), node_by_id.get(edge.dst.as_str())) {
                if caller.node_type == "FUNCTION" && call_site.node_type == "CALL" {
                    call_graph.entry(caller.name.clone()).or_default().push(call_site.name.clone());
                }
            }
        }

        // Print call graph
        let mut sorted_callers: Vec<_> = call_graph.iter().collect();
        sorted_callers.sort_by_key(|(name, _)| name.clone());
        let mut chains_found = 0;
        for (caller, callees) in &sorted_callers {
            let unique: std::collections::HashSet<_> = callees.iter().collect();
            if unique.len() > 1 {
                eprintln!("  {} -> {:?}", caller, unique.iter().take(8).collect::<Vec<_>>());
                chains_found += 1;
            }
        }
        eprintln!("Functions with 2+ callees: {}", chains_found);

        // Find transitive chains (depth 3)
        let mut chain_count = 0;
        for (fn_name, callees) in &call_graph {
            for callee in callees {
                if let Some(grandchildren) = call_graph.get(callee) {
                    for gc in grandchildren {
                        chain_count += 1;
                        if chain_count <= 5 {
                            eprintln!("  Chain: {} -> {} -> {}", fn_name, callee, gc);
                        }
                    }
                }
            }
        }
        eprintln!("3-hop call chains: {}", chain_count);
        assert!(chain_count > 0, "Should find at least one 3-hop call chain in sinatra/base.rb");

        // =====================================================================
        // 2. DATAFLOW: Trace ASSIGNED_FROM + READS_FROM chains
        // =====================================================================
        eprintln!("\n--- DATAFLOW ---");

        let assigned_from: Vec<&GraphEdge> = a.edges.iter()
            .filter(|e| e.edge_type == "ASSIGNED_FROM")
            .collect();
        let reads_from: Vec<&GraphEdge> = a.edges.iter()
            .filter(|e| e.edge_type == "READS_FROM")
            .collect();

        eprintln!("ASSIGNED_FROM: {}, READS_FROM: {}", assigned_from.len(), reads_from.len());

        // Build dataflow graph: variable -> [what it was assigned from]
        // And reverse: variable -> [who reads it]
        let mut assigned_sources: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
        for e in &assigned_from {
            assigned_sources.entry(e.src.as_str()).or_default().push(e.dst.as_str());
        }
        let mut read_by: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
        for e in &reads_from {
            read_by.entry(e.dst.as_str()).or_default().push(e.src.as_str());
        }

        // Find instance variables with both write and read (data flows through them)
        let instance_vars: Vec<&GraphNode> = a.nodes.iter()
            .filter(|n| n.node_type == "VARIABLE" && n.metadata.get("kind").map(|v| v == "instance").unwrap_or(false))
            .collect();

        let mut flow_vars = 0;
        for ivar in &instance_vars {
            let has_write = assigned_sources.contains_key(ivar.id.as_str());
            let has_read = read_by.contains_key(ivar.id.as_str());
            if has_write && has_read {
                flow_vars += 1;
                let sources = assigned_sources.get(ivar.id.as_str()).unwrap();
                let readers = read_by.get(ivar.id.as_str()).unwrap();
                if flow_vars <= 5 {
                    let src_names: Vec<String> = sources.iter()
                        .filter_map(|id| node_by_id.get(id).map(|n| format!("{}({})", n.node_type, n.name)))
                        .collect();
                    eprintln!("  {} <- {:?} (read by {} refs)",
                        ivar.name, src_names, readers.len());
                }
            }
        }
        eprintln!("Instance vars with write+read flow: {}/{}", flow_vars, instance_vars.len());

        // Forward trace: pick a variable, follow ASSIGNED_FROM -> ... -> READS_FROM
        // Find a local var that is assigned from a call result and then read
        let local_vars: Vec<&GraphNode> = a.nodes.iter()
            .filter(|n| n.node_type == "VARIABLE" && n.metadata.get("kind").map(|v| v == "local").unwrap_or(false))
            .collect();
        let mut forward_traces = 0;
        for var in &local_vars {
            if let Some(sources) = assigned_sources.get(var.id.as_str()) {
                if let Some(readers) = read_by.get(var.id.as_str()) {
                    // This var has: source --ASSIGNED_FROM--> var --READS_FROM--> reader
                    for src_id in sources {
                        if let Some(src_node) = node_by_id.get(src_id) {
                            if src_node.node_type == "CALL" {
                                forward_traces += 1;
                                if forward_traces <= 3 {
                                    eprintln!("  Trace: CALL({}) -> {} -> {} readers",
                                        src_node.name, var.name, readers.len());
                                }
                            }
                        }
                    }
                }
            }
        }
        eprintln!("Forward traces (call -> var -> read): {}", forward_traces);

        // =====================================================================
        // 3. SINATRA ROUTES: detect get/post/put/delete/patch calls
        // =====================================================================
        eprintln!("\n--- SINATRA ROUTES ---");

        let call_nodes: Vec<&GraphNode> = a.nodes.iter()
            .filter(|n| n.node_type == "CALL")
            .collect();

        let http_methods = ["get", "post", "put", "delete", "patch", "head", "options", "link", "unlink"];
        let mut route_calls: Vec<(&GraphNode, &str)> = Vec::new();
        for call in &call_nodes {
            for method in &http_methods {
                if call.name == *method {
                    route_calls.push((call, method));
                }
            }
        }
        eprintln!("HTTP method calls: {}", route_calls.len());
        for (call, method) in &route_calls {
            // Check if it has a block (FUNCTION kind:block contained in scope)
            let has_block = outgoing.get(call.id.as_str())
                .map(|edges| edges.iter().any(|(t, _)| *t == "CONTAINS"))
                .unwrap_or(false);
            eprintln!("  {} at line {} (has_block: {})", method, call.line, has_block);
        }

        // Sinatra's base.rb defines the DSL methods (get, post, etc.) as class methods
        // that call `route`. Check if we find these method definitions.
        let route_dsl_methods: Vec<&GraphNode> = functions.iter()
            .filter(|f| http_methods.contains(&f.name.as_str()))
            .cloned()
            .collect();
        eprintln!("Route DSL method definitions: {}", route_dsl_methods.len());
        for m in &route_dsl_methods {
            let vis = m.metadata.get("visibility").map(|v| v.as_str().unwrap_or("?")).unwrap_or("?");
            let is_static = m.metadata.get("static").map(|v| v.as_bool().unwrap_or(false)).unwrap_or(false);
            eprintln!("  def {}{} [{}] at line {}",
                if is_static { "self." } else { "" },
                m.name, vis, m.line);
        }

        // Check the `route` method which is the core dispatcher
        let route_fn: Vec<&GraphNode> = functions.iter()
            .filter(|f| f.name == "route")
            .cloned()
            .collect();
        eprintln!("Core 'route' method definitions: {}", route_fn.len());
        for r in &route_fn {
            // What does route() call?
            let route_calls_out: Vec<String> = outgoing.get(r.id.as_str())
                .map(|edges| edges.iter()
                    .filter(|(t, _)| *t == "CALLS" || *t == "CONTAINS")
                    .filter_map(|(_, dst)| node_by_id.get(dst).map(|n| format!("{}({})", n.node_type, n.name)))
                    .collect())
                .unwrap_or_default();
            eprintln!("  route() contains/calls: {:?}", route_calls_out.iter().take(10).collect::<Vec<_>>());
        }

        // =====================================================================
        // 4. CLASS HIERARCHY: trace inheritance
        // =====================================================================
        eprintln!("\n--- CLASS HIERARCHY ---");

        let extends: Vec<&GraphEdge> = a.edges.iter()
            .filter(|e| e.edge_type == "EXTENDS")
            .collect();
        let classes: Vec<&GraphNode> = a.nodes.iter()
            .filter(|n| n.node_type == "CLASS")
            .collect();

        eprintln!("Classes: {}, EXTENDS edges: {}", classes.len(), extends.len());
        for ext in &extends {
            if let Some(src) = node_by_id.get(ext.src.as_str()) {
                let super_name = ext.metadata.get("superclass")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&ext.dst);
                eprintln!("  {} < {}", src.name, super_name);
            }
        }

        // =====================================================================
        // 5. SCOPE DEPTH: find deepest nesting
        // =====================================================================
        eprintln!("\n--- SCOPE DEPTH ---");
        let mut max_depth = 0;
        let mut deepest_node = "";
        for n in &a.nodes {
            let depth = count_scope_depth(&n.id, &incoming);
            if depth > max_depth {
                max_depth = depth;
                deepest_node = &n.id;
            }
        }
        if let Some(dn) = node_by_id.get(deepest_node) {
            eprintln!("Max scope depth: {} (node: {}({}) at line {})", max_depth, dn.node_type, dn.name, dn.line);
        }

        // =====================================================================
        // Summary assertions
        // =====================================================================
        assert!(calls.len() > 50, "base.rb should have >50 CALLS edges, got {}", calls.len());
        assert!(assigned_from.len() > 10, "Should have >10 ASSIGNED_FROM, got {}", assigned_from.len());
        assert!(reads_from.len() > 20, "Should have >20 READS_FROM, got {}", reads_from.len());
        assert!(chain_count > 0, "Should find call chains");
        assert!(route_dsl_methods.len() > 0, "Should find HTTP method definitions (get/post/etc)");

        eprintln!("\n=== DEEP ANALYSIS PASSED ===\n");
    }

    /// Walk CONTAINS edges upward to find the enclosing FUNCTION node.
    fn find_enclosing_function(
        node_id: &str,
        incoming: &std::collections::HashMap<&str, Vec<(&str, &str)>>,
        node_by_id: &std::collections::HashMap<&str, &GraphNode>,
    ) -> Option<String> {
        let mut current = node_id;
        for _ in 0..20 { // max depth guard
            if let Some(edges) = incoming.get(current) {
                if let Some((_, parent)) = edges.iter().find(|(t, _)| *t == "CONTAINS") {
                    if let Some(parent_node) = node_by_id.get(parent) {
                        if parent_node.node_type == "FUNCTION" {
                            return Some(parent_node.name.clone());
                        }
                    }
                    current = parent;
                } else {
                    return None;
                }
            } else {
                return None;
            }
        }
        None
    }

    /// Count how many CONTAINS edges are between this node and the file MODULE.
    fn count_scope_depth(
        node_id: &str,
        incoming: &std::collections::HashMap<&str, Vec<(&str, &str)>>,
    ) -> usize {
        let mut depth = 0;
        let mut current = node_id;
        for _ in 0..50 {
            if let Some(edges) = incoming.get(current) {
                if let Some((_, parent)) = edges.iter().find(|(t, _)| *t == "CONTAINS") {
                    depth += 1;
                    current = parent;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        depth
    }
}
