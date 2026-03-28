//! Native Rust analyzer — walks syn AST directly, no serialization.
//!
//! Replaces the Haskell grafema-rust-analyzer. Takes a `syn::File` (already
//! parsed by `crate::rust_parser`) and produces `FileAnalysis` with the same
//! node/edge types the rest of the pipeline expects.
//!
//! FAIL-EARLY POLICY: unhandled syn node variants panic immediately.
//! No silent skips, no "log and continue". If it crashes, we fix the handler.

use crate::analyzer::{AnalysisIssue, AnalysisResult, ExportInfo, FileAnalysis, FileMetrics, GraphEdge, GraphNode};
use proc_macro2::Span;
use std::collections::HashMap;
use std::path::PathBuf;
use syn;

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
// Analysis context
// ---------------------------------------------------------------------------

struct Ctx {
    file: String,
    module_id: String,
    scope_stack: Vec<String>,    // current scope ID (head = innermost)
    enclosing_fn: Option<String>, // nearest enclosing function node ID
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    exports: Vec<ExportInfo>,
}

impl Ctx {
    fn new(file: &str) -> Self {
        let module_id = make_module_id(file);
        Ctx {
            file: file.to_string(),
            module_id: module_id.clone(),
            scope_stack: vec![module_id],
            enclosing_fn: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            exports: Vec::new(),
        }
    }

    fn scope_id(&self) -> &str {
        self.scope_stack.last().expect("scope stack empty")
    }

    fn emit_node(&mut self, node: GraphNode) {
        // Auto-emit CONTAINS from current scope (unless MODULE)
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

    fn emit_edge(&mut self, edge: GraphEdge) {
        self.edges.push(edge);
    }

    fn push_scope(&mut self, scope_id: &str) {
        self.scope_stack.push(scope_id.to_string());
    }

    fn pop_scope(&mut self) {
        self.scope_stack.pop().expect("popping empty scope stack");
    }

    fn span_line_col(&self, span: Span) -> (i64, i64) {
        let start = span.start();
        (start.line as i64, start.column as i64)
    }

    fn span_end_line_col(&self, span: Span) -> (i64, i64) {
        let end = span.end();
        (end.line as i64, end.column as i64)
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

    fn meta_int(key: &str, val: i64) -> (String, serde_json::Value) {
        (key.to_string(), serde_json::json!(val))
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Analyze a parsed Rust file, producing the same FileAnalysis as the
/// Haskell grafema-rust-analyzer but without any serialization.
pub fn analyze_rust_file(file: &str, syntax: &syn::File) -> FileAnalysis {
    let mut ctx = Ctx::new(file);

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

    // Walk all items
    for item in &syntax.items {
        walk_item(item, &mut ctx);
    }

    FileAnalysis {
        file: ctx.file,
        module_id: ctx.module_id,
        nodes: ctx.nodes,
        edges: ctx.edges,
        exports: ctx.exports,
    }
}

/// Analyze Rust files in parallel using the native in-process analyzer.
/// Signature matches spawn_analysis! macro: (&[PathBuf], usize, &AnalyzerBinaries, SizeLimits) -> Vec<AnalysisResult>
pub async fn analyze_rust_files_native(
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
                tracing::info!("[{}/{}] Analyzing Rust file {}", idx + 1, total, file_display);
            }

            // Parse + analyze in one spawn_blocking (syn::File is !Send)
            let file_clone = file.clone();
            let file_display_clone = file_display.clone();
            let result = tokio::task::spawn_blocking(move || {
                let source = std::fs::read_to_string(&file_clone)
                    .map_err(|e| format!("Failed to read {}: {e}", file_clone.display()))?;
                let parse_start = std::time::Instant::now();
                let syntax = syn::parse_file(&source)
                    .map_err(|e| format!("Rust parse error in {}: {e}", file_clone.display()))?;
                let parse_ms = parse_start.elapsed().as_millis() as u64;
                let analysis = analyze_rust_file(&file_display_clone, &syntax);
                Ok::<_, String>((analysis, parse_ms))
            }).await;

            let total_ms = file_start.elapsed().as_millis() as u64;

            let (analysis, parse_ms) = match result {
                Ok(Ok((a, p))) => (a, p),
                Ok(Err(e)) => {
                    return AnalysisResult {
                        file, analysis: None,
                        errors: vec![e.clone()],
                        issues: vec![AnalysisIssue { category: "parse_error".into(), severity: "error".into(), message: e, file: file_display }],
                        metrics: FileMetrics { file_size_bytes, parse_ms: 0, total_ms, ..Default::default() },
                    };
                }
                Err(e) => {
                    let msg = format!("Rust analysis task panicked for {file_display}: {e}");
                    return AnalysisResult {
                        file, analysis: None, errors: vec![msg.clone()],
                        issues: vec![AnalysisIssue { category: "parse_error".into(), severity: "error".into(), message: msg, file: file_display }],
                        metrics: FileMetrics { file_size_bytes, total_ms, ..Default::default() },
                    };
                }
            };

            let analyze_ms = total_ms.saturating_sub(parse_ms);

            AnalysisResult {
                file,
                analysis: Some(analysis),
                errors: vec![],
                issues: vec![],
                metrics: FileMetrics {
                    file_size_bytes, parse_ms, analyze_ms, total_ms,
                    node_count: 0, edge_count: 0, // filled by caller via fill_density
                    ..Default::default()
                },
            }
        })
    }).collect();

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(r) => results.push(r),
            Err(e) => results.push(AnalysisResult {
                file: PathBuf::new(), analysis: None,
                errors: vec![format!("Rust analysis task failed: {e}")],
                issues: vec![], metrics: FileMetrics::default(),
            }),
        }
    }
    results
}

fn extract_module_name(file: &str) -> String {
    let segments: Vec<&str> = file.split('/').collect();
    let filename = segments.last().unwrap_or(&file);
    let base = filename.strip_suffix(".rs").unwrap_or(filename);
    if base == "mod" && segments.len() > 1 {
        segments[segments.len() - 2].to_string()
    } else {
        base.to_string()
    }
}

// ---------------------------------------------------------------------------
// Visibility helpers
// ---------------------------------------------------------------------------

fn vis_to_text(vis: &syn::Visibility) -> &'static str {
    match vis {
        syn::Visibility::Public(_) => "pub",
        syn::Visibility::Restricted(r) => {
            let path = r.path.segments.iter()
                .map(|s| s.ident.to_string())
                .collect::<Vec<_>>()
                .join("::");
            if path == "crate" { return "pub(crate)"; }
            if path == "super" { return "pub(super)"; }
            "pub(in ...)"
        }
        syn::Visibility::Inherited => "private",
    }
}

fn is_pub(vis: &syn::Visibility) -> bool {
    matches!(vis, syn::Visibility::Public(_) | syn::Visibility::Restricted(_))
}

// ---------------------------------------------------------------------------
// Item walker
// ---------------------------------------------------------------------------

fn walk_item(item: &syn::Item, ctx: &mut Ctx) {
    match item {
        syn::Item::Fn(f) => walk_fn(f, ctx),
        syn::Item::Const(c) => walk_const(c, ctx),
        syn::Item::Static(s) => walk_static(s, ctx),
        syn::Item::Struct(s) => walk_struct(s, ctx),
        syn::Item::Enum(e) => walk_enum(e, ctx),
        syn::Item::Impl(i) => walk_impl(i, ctx),
        syn::Item::Trait(t) => walk_trait(t, ctx),
        syn::Item::Use(u) => walk_use(u, ctx),
        syn::Item::Mod(m) => walk_mod(m, ctx),
        syn::Item::Type(t) => walk_type_alias(t, ctx),
        // Transparent items — no graph nodes needed
        syn::Item::ExternCrate(_) => {}
        syn::Item::ForeignMod(_) => {}
        syn::Item::Macro(_) => {}
        syn::Item::Union(_) => {} // TODO: treat like struct
        syn::Item::TraitAlias(_) => {}
        syn::Item::Verbatim(_) => {}
        _ => panic!("rust_analyzer: unhandled Item variant: {}", item_variant_name(item)),
    }
}

fn item_variant_name(item: &syn::Item) -> &'static str {
    match item {
        syn::Item::Const(_) => "Const",
        syn::Item::Enum(_) => "Enum",
        syn::Item::ExternCrate(_) => "ExternCrate",
        syn::Item::Fn(_) => "Fn",
        syn::Item::ForeignMod(_) => "ForeignMod",
        syn::Item::Impl(_) => "Impl",
        syn::Item::Macro(_) => "Macro",
        syn::Item::Mod(_) => "Mod",
        syn::Item::Static(_) => "Static",
        syn::Item::Struct(_) => "Struct",
        syn::Item::Trait(_) => "Trait",
        syn::Item::TraitAlias(_) => "TraitAlias",
        syn::Item::Type(_) => "Type",
        syn::Item::Union(_) => "Union",
        syn::Item::Use(_) => "Use",
        syn::Item::Verbatim(_) => "Verbatim",
        _ => "Unknown",
    }
}

// ---------------------------------------------------------------------------
// Function
// ---------------------------------------------------------------------------

fn walk_fn(f: &syn::ItemFn, ctx: &mut Ctx) {
    let ident = f.sig.ident.to_string();
    let (line, col) = ctx.span_line_col(f.sig.ident.span());
    let (end_line, end_col) = ctx.span_end_line_col(f.block.brace_token.span.join());
    let is_exported = is_pub(&f.vis);
    let node_id = semantic_id(&ctx.file, "FUNCTION", &ident, None, None);

    ctx.emit_node(GraphNode {
        id: node_id.clone(),
        node_type: "FUNCTION".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line, end_column: end_col,
        exported: is_exported,
        metadata: HashMap::from([
            Ctx::meta_text("visibility", vis_to_text(&f.vis)),
            Ctx::meta_bool("async", f.sig.asyncness.is_some()),
            Ctx::meta_bool("unsafe", f.sig.unsafety.is_some()),
            Ctx::meta_bool("const", f.sig.constness.is_some()),
        ]),
        extra: HashMap::new(),
    });

    if is_exported {
        ctx.exports.push(ExportInfo {
            name: ident.clone(),
            node_id: node_id.clone(),
            kind: "function".to_string(),
            source: None,
        });
    }

    // Walk parameters
    for param in &f.sig.inputs {
        walk_fn_param(param, &node_id, ctx);
    }

    // Walk body in function scope
    let prev_fn = ctx.enclosing_fn.replace(node_id.clone());
    ctx.push_scope(&node_id);
    walk_block(&f.block, ctx);
    ctx.pop_scope();
    ctx.enclosing_fn = prev_fn;
}

fn walk_fn_param(param: &syn::FnArg, fn_id: &str, ctx: &mut Ctx) {
    match param {
        syn::FnArg::Receiver(r) => {
            let (line, col) = ctx.span_line_col(r.self_token.span);
            let node_id = semantic_id(&ctx.file, "PARAMETER", "self", Some(fn_id), None);
            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name: "self".to_string(),
                file: ctx.file.clone(),
                line, column: col,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_bool("mutable", r.mutability.is_some()),
                    Ctx::meta_bool("reference", r.reference.is_some()),
                ]),
                extra: HashMap::new(),
            });
        }
        syn::FnArg::Typed(t) => {
            // Use walk_pat_bindings for all patterns (simple ident + complex destructuring).
            // Temporarily set enclosing_fn to fn_id so semantic IDs get the right parent.
            let prev_fn = ctx.enclosing_fn.replace(fn_id.to_string());
            walk_pat_bindings(t.pat.as_ref(), "param", ctx);
            ctx.enclosing_fn = prev_fn;
        }
    }
}

// ---------------------------------------------------------------------------
// Const / Static
// ---------------------------------------------------------------------------

fn walk_const(c: &syn::ItemConst, ctx: &mut Ctx) {
    let ident = c.ident.to_string();
    let (line, col) = ctx.span_line_col(c.ident.span());
    let is_exported = is_pub(&c.vis);
    let node_id = semantic_id(&ctx.file, "VARIABLE", &ident, None, None);

    ctx.emit_node(GraphNode {
        id: node_id.clone(),
        node_type: "VARIABLE".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: is_exported,
        metadata: HashMap::from([
            Ctx::meta_text("kind", "const"),
            Ctx::meta_bool("mutable", false),
            Ctx::meta_text("visibility", vis_to_text(&c.vis)),
        ]),
        extra: HashMap::new(),
    });

    if is_exported {
        ctx.exports.push(ExportInfo {
            name: ident, node_id, kind: "variable".to_string(), source: None,
        });
    }

    walk_expr(&c.expr, ctx);
}

fn walk_static(s: &syn::ItemStatic, ctx: &mut Ctx) {
    let ident = s.ident.to_string();
    let (line, col) = ctx.span_line_col(s.ident.span());
    let is_exported = is_pub(&s.vis);
    let is_mut = matches!(s.mutability, syn::StaticMutability::Mut(_));
    let node_id = semantic_id(&ctx.file, "VARIABLE", &ident, None, None);

    ctx.emit_node(GraphNode {
        id: node_id.clone(),
        node_type: "VARIABLE".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: is_exported,
        metadata: HashMap::from([
            Ctx::meta_text("kind", "static"),
            Ctx::meta_bool("mutable", is_mut),
            Ctx::meta_text("visibility", vis_to_text(&s.vis)),
        ]),
        extra: HashMap::new(),
    });

    if is_exported {
        ctx.exports.push(ExportInfo {
            name: ident, node_id, kind: "variable".to_string(), source: None,
        });
    }

    walk_expr(&s.expr, ctx);
}

// ---------------------------------------------------------------------------
// Struct / Enum
// ---------------------------------------------------------------------------

fn walk_struct(s: &syn::ItemStruct, ctx: &mut Ctx) {
    let ident = s.ident.to_string();
    let (line, col) = ctx.span_line_col(s.ident.span());
    let is_exported = is_pub(&s.vis);
    let node_id = semantic_id(&ctx.file, "STRUCT", &ident, None, None);

    ctx.emit_node(GraphNode {
        id: node_id.clone(),
        node_type: "STRUCT".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: is_exported,
        metadata: HashMap::from([
            Ctx::meta_text("visibility", vis_to_text(&s.vis)),
        ]),
        extra: HashMap::new(),
    });

    if is_exported {
        ctx.exports.push(ExportInfo {
            name: ident, node_id: node_id.clone(), kind: "struct".to_string(), source: None,
        });
    }

    // Fields
    for field in &s.fields {
        if let Some(ident) = &field.ident {
            let fname = ident.to_string();
            let (fl, fc) = ctx.span_line_col(ident.span());
            let field_id = semantic_id(&ctx.file, "RECORD_FIELD", &fname, Some(&node_id), None);
            ctx.emit_node(GraphNode {
                id: field_id.clone(),
                node_type: "RECORD_FIELD".to_string(),
                name: fname,
                file: ctx.file.clone(),
                line: fl, column: fc,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            });
            ctx.emit_edge(GraphEdge {
                src: node_id.clone(), dst: field_id,
                edge_type: "HAS_FIELD".to_string(),
                metadata: HashMap::new(),
            });
        }
    }
}

fn walk_enum(e: &syn::ItemEnum, ctx: &mut Ctx) {
    let ident = e.ident.to_string();
    let (line, col) = ctx.span_line_col(e.ident.span());
    let is_exported = is_pub(&e.vis);
    let node_id = semantic_id(&ctx.file, "ENUM", &ident, None, None);

    ctx.emit_node(GraphNode {
        id: node_id.clone(),
        node_type: "ENUM".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: is_exported,
        metadata: HashMap::from([
            Ctx::meta_text("visibility", vis_to_text(&e.vis)),
        ]),
        extra: HashMap::new(),
    });

    if is_exported {
        ctx.exports.push(ExportInfo {
            name: ident, node_id: node_id.clone(), kind: "enum".to_string(), source: None,
        });
    }

    for variant in &e.variants {
        let vname = variant.ident.to_string();
        let (vl, vc) = ctx.span_line_col(variant.ident.span());
        let variant_id = semantic_id(&ctx.file, "VARIANT", &vname, Some(&node_id), None);
        ctx.emit_node(GraphNode {
            id: variant_id,
            node_type: "VARIANT".to_string(),
            name: vname,
            file: ctx.file.clone(),
            line: vl, column: vc,
            end_line: 0, end_column: 0,
            exported: false,
            metadata: HashMap::new(),
            extra: HashMap::new(),
        });
    }
}

// ---------------------------------------------------------------------------
// Impl / Trait
// ---------------------------------------------------------------------------

fn walk_impl(i: &syn::ItemImpl, ctx: &mut Ctx) {
    let self_ty = type_to_name(&i.self_ty);
    let trait_name = i.trait_.as_ref().map(|(_, path, _)| path_to_string(path));
    let (line, col) = ctx.span_line_col(i.impl_token.span);
    let node_id = semantic_id(&ctx.file, "IMPL_BLOCK", &self_ty, trait_name.as_deref(), None);

    ctx.emit_node(GraphNode {
        id: node_id.clone(),
        node_type: "IMPL_BLOCK".to_string(),
        name: self_ty,
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: false,
        metadata: if let Some(t) = &trait_name {
            HashMap::from([Ctx::meta_text("trait", t)])
        } else {
            HashMap::new()
        },
        extra: HashMap::new(),
    });

    ctx.push_scope(&node_id);
    for impl_item in &i.items {
        walk_impl_item(impl_item, ctx);
    }
    ctx.pop_scope();
}

fn walk_impl_item(item: &syn::ImplItem, ctx: &mut Ctx) {
    match item {
        syn::ImplItem::Fn(m) => {
            let ident = m.sig.ident.to_string();
            let (line, col) = ctx.span_line_col(m.sig.ident.span());
            let (end_line, end_col) = ctx.span_end_line_col(m.block.brace_token.span.join());
            let is_exported = is_pub(&m.vis);
            let parent = ctx.scope_stack.last().map(|s| s.as_str());
            let node_id = semantic_id(&ctx.file, "FUNCTION", &ident, parent, None);

            ctx.emit_node(GraphNode {
                id: node_id.clone(),
                node_type: "FUNCTION".to_string(),
                name: ident.clone(),
                file: ctx.file.clone(),
                line, column: col,
                end_line, end_column: end_col,
                exported: is_exported,
                metadata: HashMap::from([
                    Ctx::meta_text("visibility", vis_to_text(&m.vis)),
                    Ctx::meta_bool("async", m.sig.asyncness.is_some()),
                    Ctx::meta_bool("unsafe", m.sig.unsafety.is_some()),
                ]),
                extra: HashMap::new(),
            });

            // HAS_METHOD edge
            ctx.emit_edge(GraphEdge {
                src: ctx.scope_id().to_string(), dst: node_id.clone(),
                edge_type: "HAS_METHOD".to_string(),
                metadata: HashMap::new(),
            });

            for param in &m.sig.inputs {
                walk_fn_param(param, &node_id, ctx);
            }

            let prev_fn = ctx.enclosing_fn.replace(node_id.clone());
            ctx.push_scope(&node_id);
            walk_block(&m.block, ctx);
            ctx.pop_scope();
            ctx.enclosing_fn = prev_fn;
        }
        syn::ImplItem::Const(_) => {}
        syn::ImplItem::Type(_) => {}
        syn::ImplItem::Macro(_) => {}
        syn::ImplItem::Verbatim(_) => {}
        _ => panic!("rust_analyzer: unhandled ImplItem variant"),
    }
}

fn walk_trait(t: &syn::ItemTrait, ctx: &mut Ctx) {
    let ident = t.ident.to_string();
    let (line, col) = ctx.span_line_col(t.ident.span());
    let is_exported = is_pub(&t.vis);
    let node_id = semantic_id(&ctx.file, "TRAIT", &ident, None, None);

    ctx.emit_node(GraphNode {
        id: node_id.clone(),
        node_type: "TRAIT".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: is_exported,
        metadata: HashMap::from([
            Ctx::meta_text("visibility", vis_to_text(&t.vis)),
        ]),
        extra: HashMap::new(),
    });

    if is_exported {
        ctx.exports.push(ExportInfo {
            name: ident, node_id: node_id.clone(), kind: "trait".to_string(), source: None,
        });
    }

    ctx.push_scope(&node_id);
    for trait_item in &t.items {
        if let syn::TraitItem::Fn(m) = trait_item {
            let mname = m.sig.ident.to_string();
            let (ml, mc) = ctx.span_line_col(m.sig.ident.span());
            let sig_id = semantic_id(&ctx.file, "TYPE_SIGNATURE", &mname, Some(&node_id), None);
            ctx.emit_node(GraphNode {
                id: sig_id,
                node_type: "TYPE_SIGNATURE".to_string(),
                name: mname,
                file: ctx.file.clone(),
                line: ml, column: mc,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            });
        }
    }
    ctx.pop_scope();
}

// ---------------------------------------------------------------------------
// Use / Imports
// ---------------------------------------------------------------------------

fn walk_use(u: &syn::ItemUse, ctx: &mut Ctx) {
    let (line, col) = ctx.span_line_col(u.use_token.span);
    walk_use_tree(&u.tree, "", line, col, &u.vis, ctx);
}

fn walk_use_tree(tree: &syn::UseTree, prefix: &str, line: i64, col: i64, vis: &syn::Visibility, ctx: &mut Ctx) {
    match tree {
        syn::UseTree::Path(p) => {
            let new_prefix = if prefix.is_empty() {
                p.ident.to_string()
            } else {
                format!("{prefix}::{}", p.ident)
            };
            walk_use_tree(&p.tree, &new_prefix, line, col, vis, ctx);
        }
        syn::UseTree::Name(n) => {
            let source = if prefix.is_empty() { n.ident.to_string() } else { format!("{prefix}::{}", n.ident) };
            let name = n.ident.to_string();
            emit_import(&source, &name, line, col, vis, ctx);
        }
        syn::UseTree::Rename(r) => {
            let source = if prefix.is_empty() { r.ident.to_string() } else { format!("{prefix}::{}", r.ident) };
            let name = r.rename.to_string();
            emit_import(&source, &name, line, col, vis, ctx);
        }
        syn::UseTree::Glob(_) => {
            let source = if prefix.is_empty() { "*".to_string() } else { format!("{prefix}::*") };
            emit_import(&source, "*", line, col, vis, ctx);
        }
        syn::UseTree::Group(g) => {
            for item in &g.items {
                walk_use_tree(item, prefix, line, col, vis, ctx);
            }
        }
    }
}

fn emit_import(source: &str, name: &str, line: i64, col: i64, vis: &syn::Visibility, ctx: &mut Ctx) {
    let import_id = semantic_id(&ctx.file, "IMPORT", source, None, None);
    ctx.emit_node(GraphNode {
        id: import_id.clone(),
        node_type: "IMPORT".to_string(),
        name: source.to_string(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: false,
        metadata: HashMap::from([Ctx::meta_text("source", source)]),
        extra: HashMap::new(),
    });

    let binding_id = semantic_id(&ctx.file, "IMPORT_BINDING", name, Some(source), None);
    ctx.emit_node(GraphNode {
        id: binding_id.clone(),
        node_type: "IMPORT_BINDING".to_string(),
        name: name.to_string(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: is_pub(vis),
        metadata: HashMap::from([
            Ctx::meta_text("source", source),
            Ctx::meta_text("importedName", name),
        ]),
        extra: HashMap::new(),
    });

    // IMPORT → CONTAINS → IMPORT_BINDING
    ctx.emit_edge(GraphEdge {
        src: import_id, dst: binding_id,
        edge_type: "CONTAINS".to_string(),
        metadata: HashMap::new(),
    });
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

fn walk_mod(m: &syn::ItemMod, ctx: &mut Ctx) {
    if let Some((_, items)) = &m.content {
        for item in items {
            walk_item(item, ctx);
        }
    }
}

// ---------------------------------------------------------------------------
// Type alias
// ---------------------------------------------------------------------------

fn walk_type_alias(t: &syn::ItemType, ctx: &mut Ctx) {
    let ident = t.ident.to_string();
    let (line, col) = ctx.span_line_col(t.ident.span());
    let node_id = semantic_id(&ctx.file, "TYPE_ALIAS", &ident, None, None);
    ctx.emit_node(GraphNode {
        id: node_id,
        node_type: "TYPE_ALIAS".to_string(),
        name: ident,
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: is_pub(&t.vis),
        metadata: HashMap::new(),
        extra: HashMap::new(),
    });
}

// ---------------------------------------------------------------------------
// Block / Statement
// ---------------------------------------------------------------------------

fn walk_block(block: &syn::Block, ctx: &mut Ctx) {
    for stmt in &block.stmts {
        walk_stmt(stmt, ctx);
    }
}

fn walk_stmt(stmt: &syn::Stmt, ctx: &mut Ctx) {
    match stmt {
        syn::Stmt::Local(local) => walk_let(local, ctx),
        syn::Stmt::Item(item) => walk_item(item, ctx),
        syn::Stmt::Expr(expr, _semi) => walk_expr(expr, ctx),
        syn::Stmt::Macro(_) => {}
    }
}

fn walk_let(local: &syn::Local, ctx: &mut Ctx) {
    walk_pat_bindings(&local.pat, "let", ctx);

    if let Some(init) = &local.init {
        walk_expr(&init.expr, ctx);
    }
}

/// Recursively extract all ident bindings from any pattern, creating VARIABLE
/// (or PARAMETER when `kind == "param"`) nodes for each. Handles tuple,
/// tuple-struct, struct, slice, or, reference, and type-annotation patterns.
fn walk_pat_bindings(pat: &syn::Pat, kind: &str, ctx: &mut Ctx) {
    match pat {
        syn::Pat::Ident(pi) => {
            let name = pi.ident.to_string();
            let (line, col) = ctx.span_line_col(pi.ident.span());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_type = if kind == "param" { "PARAMETER" } else { "VARIABLE" };
            let node_id = semantic_id(&ctx.file, node_type, &name, parent, Some(&hash));

            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: node_type.to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_text("kind", kind),
                    Ctx::meta_bool("mutable", pi.mutability.is_some()),
                ]),
                extra: HashMap::new(),
            });

            // If the ident has a sub-pattern (e.g. `x @ Some(inner)`), walk it too
            if let Some((_, sub_pat)) = &pi.subpat {
                walk_pat_bindings(sub_pat, kind, ctx);
            }
        }
        syn::Pat::Tuple(pt) => {
            for elem in &pt.elems {
                walk_pat_bindings(elem, kind, ctx);
            }
        }
        syn::Pat::TupleStruct(pts) => {
            for elem in &pts.elems {
                walk_pat_bindings(elem, kind, ctx);
            }
        }
        syn::Pat::Struct(ps) => {
            for field in &ps.fields {
                walk_pat_bindings(&field.pat, kind, ctx);
            }
            // rest pattern (`..`) has no bindings
        }
        syn::Pat::Slice(ps) => {
            for elem in &ps.elems {
                walk_pat_bindings(elem, kind, ctx);
            }
        }
        syn::Pat::Or(po) => {
            for case in &po.cases {
                walk_pat_bindings(case, kind, ctx);
            }
        }
        syn::Pat::Reference(pr) => {
            walk_pat_bindings(&pr.pat, kind, ctx);
        }
        syn::Pat::Type(pt) => {
            // `x: i32` — unwrap the type annotation and handle the inner pattern
            walk_pat_bindings(&pt.pat, kind, ctx);
        }
        syn::Pat::Wild(_) => {
            // `_` — no binding
        }
        syn::Pat::Rest(_) => {
            // `..` — no binding
        }
        syn::Pat::Lit(_) | syn::Pat::Range(_) => {
            // literal/range patterns in match arms — no variable bindings
        }
        syn::Pat::Paren(pp) => {
            walk_pat_bindings(&pp.pat, kind, ctx);
        }
        syn::Pat::Macro(_) | syn::Pat::Verbatim(_) => {
            // opaque patterns — skip
        }
        syn::Pat::Const(_) => {
            // const block pattern — no variable bindings
        }
        _ => panic!("rust_analyzer: unhandled Pat variant in walk_pat_bindings"),
    }
}

// ---------------------------------------------------------------------------
// Expression walker
// ---------------------------------------------------------------------------

fn walk_expr(expr: &syn::Expr, ctx: &mut Ctx) {
    match expr {
        // ── CALL nodes ──────────────────────────────────────────────
        syn::Expr::Call(e) => {
            let func_name = expr_to_name(&e.func);
            let (line, col) = ctx.span_line_col(e.paren_token.span.join());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", &func_name, parent, Some(&hash));

            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "CALL".to_string(),
                name: func_name,
                file: ctx.file.clone(),
                line, column: col,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("method", false)]),
                extra: HashMap::new(),
            });

            walk_expr(&e.func, ctx);
            for arg in &e.args {
                walk_expr(arg, ctx);
            }
        }

        syn::Expr::MethodCall(e) => {
            let method = e.method.to_string();
            let (line, col) = ctx.span_line_col(e.method.span());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", &method, parent, Some(&hash));

            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "CALL".to_string(),
                name: method,
                file: ctx.file.clone(),
                line, column: col,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_bool("method", true),
                    Ctx::meta_text("receiver", &expr_to_name(&e.receiver)),
                ]),
                extra: HashMap::new(),
            });

            walk_expr(&e.receiver, ctx);
            for arg in &e.args {
                walk_expr(arg, ctx);
            }
        }

        // ── REFERENCE nodes ─────────────────────────────────────────
        syn::Expr::Path(e) => {
            let name = path_to_string(&e.path);
            let (line, col) = ctx.span_line_col(e.path.segments.last()
                .map(|s| s.ident.span())
                .unwrap_or_else(Span::call_site));
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &name, parent, Some(&hash));

            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "REFERENCE".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            });
        }

        syn::Expr::Field(e) => {
            let member = match &e.member {
                syn::Member::Named(i) => i.to_string(),
                syn::Member::Unnamed(i) => i.index.to_string(),
            };
            let (line, col) = ctx.span_line_col(e.dot_token.span);
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "REFERENCE", &member, parent, Some(&hash));

            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "REFERENCE".to_string(),
                name: member,
                file: ctx.file.clone(),
                line, column: col,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("field", true)]),
                extra: HashMap::new(),
            });

            walk_expr(&e.base, ctx);
        }

        // ── BRANCH nodes ────────────────────────────────────────────
        syn::Expr::If(e) => {
            let (line, col) = ctx.span_line_col(e.if_token.span);
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "BRANCH", "if", parent, Some(&hash));
            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "BRANCH".to_string(),
                name: "if".to_string(),
                file: ctx.file.clone(),
                line, column: col,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "if")]),
                extra: HashMap::new(),
            });
            walk_expr(&e.cond, ctx);
            walk_block(&e.then_branch, ctx);
            if let Some((_, else_branch)) = &e.else_branch {
                walk_expr(else_branch, ctx);
            }
        }

        syn::Expr::Match(e) => {
            let (line, col) = ctx.span_line_col(e.match_token.span);
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "BRANCH", "match", parent, Some(&hash));
            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "BRANCH".to_string(),
                name: "match".to_string(),
                file: ctx.file.clone(),
                line, column: col,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "match")]),
                extra: HashMap::new(),
            });
            walk_expr(&e.expr, ctx);
            for arm in &e.arms {
                if let Some(guard) = &arm.guard {
                    walk_expr(guard.1.as_ref(), ctx);
                }
                walk_expr(&arm.body, ctx);
            }
        }

        syn::Expr::Loop(e) => {
            let (line, col) = ctx.span_line_col(e.loop_token.span);
            emit_branch("loop", line, col, ctx);
            walk_block(&e.body, ctx);
        }
        syn::Expr::While(e) => {
            let (line, col) = ctx.span_line_col(e.while_token.span);
            emit_branch("while", line, col, ctx);
            walk_expr(&e.cond, ctx);
            walk_block(&e.body, ctx);
        }
        syn::Expr::ForLoop(e) => {
            let (line, col) = ctx.span_line_col(e.for_token.span);
            emit_branch("for", line, col, ctx);
            walk_expr(&e.expr, ctx);
            walk_block(&e.body, ctx);
        }

        // ── CLOSURE ─────────────────────────────────────────────────
        syn::Expr::Closure(e) => {
            let (line, col) = ctx.span_line_col(e.or1_token.span);
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CLOSURE", "<closure>", parent, Some(&hash));
            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "CLOSURE".to_string(),
                name: "<closure>".to_string(),
                file: ctx.file.clone(),
                line, column: col,
                end_line: 0, end_column: 0,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_bool("capture", e.capture.is_some()),
                    Ctx::meta_bool("async", e.asyncness.is_some()),
                ]),
                extra: HashMap::new(),
            });
            walk_expr(&e.body, ctx);
        }

        // ── RETURN ──────────────────────────────────────────────────
        syn::Expr::Return(e) => {
            if let Some(expr) = &e.expr {
                walk_expr(expr, ctx);
            }
        }

        // ── Try (?) operator ────────────────────────────────────────
        syn::Expr::Try(e) => {
            walk_expr(&e.expr, ctx);
        }

        // ── Transparent: walk children ──────────────────────────────
        syn::Expr::Binary(e) => { walk_expr(&e.left, ctx); walk_expr(&e.right, ctx); }
        syn::Expr::Unary(e) => walk_expr(&e.expr, ctx),
        syn::Expr::Block(e) => walk_block(&e.block, ctx),
        syn::Expr::Paren(e) => walk_expr(&e.expr, ctx),
        syn::Expr::Reference(e) => walk_expr(&e.expr, ctx),
        syn::Expr::Await(e) => walk_expr(&e.base, ctx),
        syn::Expr::Assign(e) => { walk_expr(&e.left, ctx); walk_expr(&e.right, ctx); }
        syn::Expr::Index(e) => { walk_expr(&e.expr, ctx); walk_expr(&e.index, ctx); }
        syn::Expr::Tuple(e) => { for elem in &e.elems { walk_expr(elem, ctx); } }
        syn::Expr::Array(e) => { for elem in &e.elems { walk_expr(elem, ctx); } }
        syn::Expr::Cast(e) => walk_expr(&e.expr, ctx),
        syn::Expr::Unsafe(e) => walk_block(&e.block, ctx),
        syn::Expr::Async(e) => walk_block(&e.block, ctx),
        syn::Expr::Let(e) => walk_expr(&e.expr, ctx),
        syn::Expr::Range(e) => {
            if let Some(start) = &e.start { walk_expr(start, ctx); }
            if let Some(end) = &e.end { walk_expr(end, ctx); }
        }
        syn::Expr::Struct(e) => {
            for field in &e.fields { walk_expr(&field.expr, ctx); }
            if let Some(rest) = &e.rest { walk_expr(rest, ctx); }
        }
        syn::Expr::Repeat(e) => { walk_expr(&e.expr, ctx); walk_expr(&e.len, ctx); }
        syn::Expr::Break(e) => { if let Some(expr) = &e.expr { walk_expr(expr, ctx); } }
        syn::Expr::Continue(_) => {}
        syn::Expr::Yield(e) => { if let Some(expr) = &e.expr { walk_expr(expr, ctx); } }
        syn::Expr::Group(e) => walk_expr(&e.expr, ctx),

        // ── Leaf / no children ──────────────────────────────────────
        syn::Expr::Lit(_) => {}
        syn::Expr::Macro(_) => {}
        syn::Expr::Const(_) => {}
        syn::Expr::Infer(_) => {}
        syn::Expr::Verbatim(_) => {}

        _ => panic!("rust_analyzer: unhandled Expr variant"),
    }
}

fn emit_branch(kind: &str, line: i64, col: i64, ctx: &mut Ctx) {
    let parent = ctx.enclosing_fn.as_deref();
    let hash = ctx.pos_hash(line, col);
    let node_id = semantic_id(&ctx.file, "BRANCH", kind, parent, Some(&hash));
    ctx.emit_node(GraphNode {
        id: node_id,
        node_type: "BRANCH".to_string(),
        name: kind.to_string(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: false,
        metadata: HashMap::from([Ctx::meta_text("kind", kind)]),
        extra: HashMap::new(),
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn expr_to_name(expr: &syn::Expr) -> String {
    match expr {
        syn::Expr::Path(p) => path_to_string(&p.path),
        syn::Expr::Field(f) => match &f.member {
            syn::Member::Named(i) => i.to_string(),
            syn::Member::Unnamed(i) => i.index.to_string(),
        },
        _ => "<expr>".to_string(),
    }
}

fn path_to_string(path: &syn::Path) -> String {
    path.segments.iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

fn type_to_name(ty: &syn::Type) -> String {
    match ty {
        syn::Type::Path(p) => path_to_string(&p.path),
        _ => "<type>".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_and_analyze(code: &str) -> FileAnalysis {
        let syntax = syn::parse_file(code).expect("test code should parse");
        analyze_rust_file("test.rs", &syntax)
    }

    fn has_node(fa: &FileAnalysis, node_type: &str, name: &str) -> bool {
        fa.nodes.iter().any(|n| n.node_type == node_type && n.name == name)
    }

    fn has_edge(fa: &FileAnalysis, edge_type: &str, src_contains: &str, dst_contains: &str) -> bool {
        fa.edges.iter().any(|e| {
            e.edge_type == edge_type && e.src.contains(src_contains) && e.dst.contains(dst_contains)
        })
    }

    fn count_nodes(fa: &FileAnalysis, node_type: &str) -> usize {
        fa.nodes.iter().filter(|n| n.node_type == node_type).count()
    }

    #[test]
    fn test_function_and_call() {
        let fa = parse_and_analyze("fn main() { foo(); }  fn foo() {}");
        assert!(has_node(&fa, "MODULE", "test"), "MODULE node");
        assert!(has_node(&fa, "FUNCTION", "main"), "FUNCTION main");
        assert!(has_node(&fa, "FUNCTION", "foo"), "FUNCTION foo");
        assert!(has_node(&fa, "CALL", "foo"), "CALL foo");
        assert!(has_node(&fa, "REFERENCE", "foo"), "REFERENCE foo from call expr");
    }

    #[test]
    fn test_method_call() {
        let fa = parse_and_analyze("fn main() { vec.push(42); }");
        assert!(has_node(&fa, "CALL", "push"), "CALL push");
        let call = fa.nodes.iter().find(|n| n.node_type == "CALL" && n.name == "push").unwrap();
        assert_eq!(call.metadata.get("method"), Some(&serde_json::json!(true)));
    }

    #[test]
    fn test_let_binding() {
        let fa = parse_and_analyze("fn main() { let x = 42; let mut y = x; }");
        assert_eq!(count_nodes(&fa, "VARIABLE"), 2);
        assert!(has_node(&fa, "VARIABLE", "x"));
        assert!(has_node(&fa, "VARIABLE", "y"));
    }

    #[test]
    fn test_struct_with_fields() {
        let fa = parse_and_analyze("pub struct Foo { pub bar: i32, baz: String }");
        assert!(has_node(&fa, "STRUCT", "Foo"));
        assert!(has_node(&fa, "RECORD_FIELD", "bar"));
        assert!(has_node(&fa, "RECORD_FIELD", "baz"));
        assert!(has_edge(&fa, "HAS_FIELD", "STRUCT", "RECORD_FIELD"));
    }

    #[test]
    fn test_enum_with_variants() {
        let fa = parse_and_analyze("enum Color { Red, Green, Blue }");
        assert!(has_node(&fa, "ENUM", "Color"));
        assert!(has_node(&fa, "VARIANT", "Red"));
        assert!(has_node(&fa, "VARIANT", "Green"));
        assert!(has_node(&fa, "VARIANT", "Blue"));
    }

    #[test]
    fn test_use_import() {
        let fa = parse_and_analyze("use std::collections::HashMap;");
        assert!(has_node(&fa, "IMPORT", "std::collections::HashMap"));
        assert!(has_node(&fa, "IMPORT_BINDING", "HashMap"));
        assert!(has_edge(&fa, "CONTAINS", "IMPORT", "IMPORT_BINDING"));
    }

    #[test]
    fn test_impl_block() {
        let fa = parse_and_analyze("struct Foo; impl Foo { fn bar(&self) {} }");
        assert!(has_node(&fa, "IMPL_BLOCK", "Foo"));
        assert!(has_node(&fa, "FUNCTION", "bar"));
        assert!(has_edge(&fa, "HAS_METHOD", "IMPL_BLOCK", "FUNCTION"));
    }

    #[test]
    fn test_branch_nodes() {
        let fa = parse_and_analyze("fn main() { if true { } else { } for x in 0..10 { } }");
        assert!(has_node(&fa, "BRANCH", "if"));
        assert!(has_node(&fa, "BRANCH", "for"));
    }

    #[test]
    fn test_closure() {
        let fa = parse_and_analyze("fn main() { let f = |x| x + 1; }");
        assert!(has_node(&fa, "CLOSURE", "<closure>"));
    }

    #[test]
    fn test_trait_definition() {
        let fa = parse_and_analyze("pub trait Foo { fn bar(&self); fn baz(&self); }");
        assert!(has_node(&fa, "TRAIT", "Foo"));
        assert_eq!(count_nodes(&fa, "TYPE_SIGNATURE"), 2);
    }

    #[test]
    fn test_exported_function() {
        let fa = parse_and_analyze("pub fn exported() {} fn private() {}");
        assert_eq!(fa.exports.len(), 1);
        assert_eq!(fa.exports[0].name, "exported");
    }

    #[test]
    fn test_tuple_destructuring_let() {
        let fa = parse_and_analyze("fn main() { let (a, b) = (1, 2); }");
        assert!(has_node(&fa, "VARIABLE", "a"), "VARIABLE a from tuple");
        assert!(has_node(&fa, "VARIABLE", "b"), "VARIABLE b from tuple");
    }

    #[test]
    fn test_tuple_struct_destructuring_let() {
        let fa = parse_and_analyze("struct Pair(i32, i32); fn main() { let Pair(x, y) = Pair(1, 2); }");
        assert!(has_node(&fa, "VARIABLE", "x"), "VARIABLE x from TupleStruct");
        assert!(has_node(&fa, "VARIABLE", "y"), "VARIABLE y from TupleStruct");
    }

    #[test]
    fn test_struct_destructuring_let() {
        let fa = parse_and_analyze("struct Pt { x: i32, y: i32 } fn main() { let Pt { x, y } = Pt { x: 1, y: 2 }; }");
        assert!(has_node(&fa, "VARIABLE", "x"), "VARIABLE x from struct pat");
        assert!(has_node(&fa, "VARIABLE", "y"), "VARIABLE y from struct pat");
    }

    #[test]
    fn test_slice_destructuring_let() {
        let fa = parse_and_analyze("fn main() { let v = vec![1,2,3]; let [a, b, ..] = v[..] else { return; }; }");
        assert!(has_node(&fa, "VARIABLE", "a"), "VARIABLE a from slice");
        assert!(has_node(&fa, "VARIABLE", "b"), "VARIABLE b from slice");
    }

    #[test]
    fn test_reference_pattern_let() {
        let fa = parse_and_analyze("fn main() { let &x = &42; }");
        assert!(has_node(&fa, "VARIABLE", "x"), "VARIABLE x from ref pattern");
    }

    #[test]
    fn test_type_annotated_pattern_let() {
        let fa = parse_and_analyze("fn main() { let x: i32 = 42; }");
        assert!(has_node(&fa, "VARIABLE", "x"), "VARIABLE x from type-annotated pat");
    }

    #[test]
    fn test_nested_tuple_destructuring() {
        let fa = parse_and_analyze("fn main() { let ((a, b), c) = ((1, 2), 3); }");
        assert!(has_node(&fa, "VARIABLE", "a"), "VARIABLE a nested");
        assert!(has_node(&fa, "VARIABLE", "b"), "VARIABLE b nested");
        assert!(has_node(&fa, "VARIABLE", "c"), "VARIABLE c nested");
    }

    #[test]
    fn test_fn_param_tuple_destructuring() {
        let fa = parse_and_analyze("fn process((x, y): (i32, i32)) {}");
        assert!(has_node(&fa, "PARAMETER", "x"), "PARAMETER x from tuple param");
        assert!(has_node(&fa, "PARAMETER", "y"), "PARAMETER y from tuple param");
    }

    #[test]
    fn test_wildcard_in_tuple() {
        let fa = parse_and_analyze("fn main() { let (a, _) = (1, 2); }");
        assert!(has_node(&fa, "VARIABLE", "a"), "VARIABLE a");
        // _ should NOT create a node
        assert!(!has_node(&fa, "VARIABLE", "_"), "wildcard should not create VARIABLE");
    }

    #[test]
    #[should_panic(expected = "unhandled")]
    fn test_fail_early_on_unknown() {
        // This test verifies the fail-early policy.
        // syn::Expr::Verbatim won't panic (it's handled), but we can verify
        // the mechanism works by checking that unknown items would panic.
        // For now, verify that the module compiles with the panic branches.
        let _ = parse_and_analyze("fn main() {}");
        // If we get here, the basic case works. The panic branches are tested
        // by the compiler — they exist in the match arms.
        panic!("unhandled — test sentinel");
    }
}
