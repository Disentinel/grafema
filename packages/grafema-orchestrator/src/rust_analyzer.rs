//! Native Rust analyzer — walks syn AST directly, no serialization.
//!
//! Takes a `syn::File` (already parsed by `crate::rust_parser`) and produces
//! `FileAnalysis` with the same node/edge types the rest of the pipeline expects.
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

// ---------------------------------------------------------------------------
// Scope kinds — matching JS analyzer's scope hierarchy
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum ScopeKind {
    Module,
    Function,
    Block,    // if/match/loop/for/while/unsafe/async blocks
    Impl,
    Trait,
}

impl ScopeKind {
    fn as_str(self) -> &'static str {
        match self {
            ScopeKind::Module => "module",
            ScopeKind::Function => "function",
            ScopeKind::Block => "block",
            ScopeKind::Impl => "impl",
            ScopeKind::Trait => "trait",
        }
    }
}

// ---------------------------------------------------------------------------
// Deferred references — collected during walk, resolved after
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct DeferredRef {
    name: String,
    from_node_id: String,
    edge_type: String, // "READS_FROM" or "CALLS"
    scope_id: String,
}

struct Ctx {
    file: String,
    module_id: String,
    scope_stack: Vec<String>,    // current scope ID (head = innermost)
    scope_kinds: Vec<ScopeKind>, // parallel to scope_stack
    enclosing_fn: Option<String>, // nearest enclosing function node ID
    /// Trait name if we are inside a `impl TraitName for Type` block.
    /// Used to tag FUNCTION nodes with `metadata["trait"]` for dyn dispatch resolution.
    enclosing_trait: Option<String>,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    exports: Vec<ExportInfo>,
    /// Declarations per scope: scope_id → Vec<(name, node_id)>
    declarations: HashMap<String, Vec<(String, String)>>,
    /// Parent scope map: child_scope_id → parent_scope_id
    scope_parents: HashMap<String, String>,
    /// Deferred references to resolve after walk
    deferred_refs: Vec<DeferredRef>,
    /// Type annotation being threaded through walk_pat_bindings
    pending_type_annotation: Option<String>,
}

impl Ctx {
    fn new(file: &str) -> Self {
        let module_id = make_module_id(file);
        Ctx {
            file: file.to_string(),
            module_id: module_id.clone(),
            scope_stack: vec![module_id],
            scope_kinds: vec![ScopeKind::Module],
            enclosing_fn: None,
            enclosing_trait: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            exports: Vec::new(),
            declarations: HashMap::new(),
            scope_parents: HashMap::new(),
            deferred_refs: Vec::new(),
            pending_type_annotation: None,
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

    /// Emit a declaration node: CONTAINS + DECLARES edges from current scope.
    fn emit_declaration(&mut self, node: GraphNode) {
        let scope = self.scope_id().to_string();
        let name = node.name.clone();
        let id = node.id.clone();

        // CONTAINS edge (auto)
        self.edges.push(GraphEdge {
            src: scope.clone(),
            dst: id.clone(),
            edge_type: "CONTAINS".to_string(),
            metadata: HashMap::new(),
        });

        // DECLARES edge — scope declares this binding
        self.edges.push(GraphEdge {
            src: scope.clone(),
            dst: id.clone(),
            edge_type: "DECLARES".to_string(),
            metadata: HashMap::new(),
        });

        // Track for scope resolution
        self.declarations.entry(scope).or_default().push((name, id));

        self.nodes.push(node);
    }

    fn emit_edge(&mut self, edge: GraphEdge) {
        self.edges.push(edge);
    }

    /// Push a new scope. For Block scopes, emits a SCOPE node + HAS_SCOPE edge.
    /// For Function/Impl/Trait, the existing node IS the scope (no separate SCOPE node).
    fn push_scope(&mut self, scope_id: &str, kind: ScopeKind) {
        self.push_scope_with_span(scope_id, kind, None);
    }

    fn push_scope_with_span(&mut self, scope_id: &str, kind: ScopeKind, span: Option<Span>) {
        let parent = self.scope_id().to_string();

        // Only emit SCOPE node for block scopes — functions/impls/traits are their own scope
        if matches!(kind, ScopeKind::Block) {
            let (line, col) = span.map(|s| self.span_line_col(s)).unwrap_or((0, 0));
            let (end_line, end_col) = span.map(|s| self.span_end_line_col(s)).unwrap_or((0, 0));
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

        // HAS_SCOPE edge from parent
        self.edges.push(GraphEdge {
            src: parent.clone(),
            dst: scope_id.to_string(),
            edge_type: "HAS_SCOPE".to_string(),
            metadata: HashMap::new(),
        });

        // Track parent for scope resolution
        self.scope_parents.insert(scope_id.to_string(), parent);

        self.scope_stack.push(scope_id.to_string());
        self.scope_kinds.push(kind);
    }

    fn pop_scope(&mut self) {
        self.scope_stack.pop().expect("popping empty scope stack");
        self.scope_kinds.pop();
    }

    /// Add a deferred reference to resolve after walk completes.
    fn defer_ref(&mut self, name: &str, from_node_id: &str, edge_type: &str) {
        self.deferred_refs.push(DeferredRef {
            name: name.to_string(),
            from_node_id: from_node_id.to_string(),
            edge_type: edge_type.to_string(),
            scope_id: self.scope_id().to_string(),
        });
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

    /// Record an unrecognised AST construct without aborting analysis of the file.
    ///
    /// `syn`'s `Item`/`Expr`/`Pat`/etc. enums are `#[non_exhaustive]`, and new
    /// stable variants land with most Rust releases. Historically every walker's
    /// catch-all arm `panic!`ed on a variant it didn't recognise. Because per-file
    /// analysis runs inside `spawn_blocking`, that panic was caught upstream
    /// (`analyze_rust_files_native`) and the ENTIRE file was discarded
    /// (`analysis: None`) and mislabelled a `parse_error` — so a single
    /// unrecognised construct (e.g. the `&raw const` operator, stable since Rust
    /// 1.82) made every node and edge in an otherwise-parseable file vanish from
    /// the graph. That directly violates the core thesis that the graph must be
    /// trustworthy enough to query instead of reading the source.
    ///
    /// Instead we degrade gracefully: the unknown construct is skipped (its
    /// children are not walked, so the graph for this file is partial) but the
    /// rest of the file is still analysed, and the gap is surfaced as a
    /// `tracing::warn!` so it is visible ("here be dragons") rather than silent.
    /// `kind` is the enum name (e.g. `"Expr"`); `detail` is a concrete variant
    /// name when known, or `""` when not.
    fn warn_unhandled(&self, kind: &str, detail: &str) {
        if detail.is_empty() {
            tracing::warn!(
                "rust_analyzer: unhandled {kind} variant in {} — skipping (graph for this file will be partial)",
                self.file
            );
        } else {
            tracing::warn!(
                "rust_analyzer: unhandled {kind} variant `{detail}` in {} — skipping (graph for this file will be partial)",
                self.file
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Analyze a parsed Rust file, producing FileAnalysis directly without serialization.
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
/// For each DeferredRef, finds the nearest declaration with matching name
/// by traversing scope_parents upward from the ref's scope.
fn resolve_refs(ctx: &mut Ctx) {
    let refs = std::mem::take(&mut ctx.deferred_refs);
    let mut new_edges = Vec::new();

    for dr in &refs {
        let mut scope = dr.scope_id.clone();
        let mut resolved = false;

        // Walk scope chain upward
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
            // Move to parent scope
            match ctx.scope_parents.get(&scope) {
                Some(parent) => scope = parent.clone(),
                None => break, // reached top
            }
        }

        if !resolved {
            // Mark the REFERENCE node as unresolved
            if let Some(node) = ctx.nodes.iter_mut().find(|n| n.id == dr.from_node_id) {
                node.metadata.insert("resolved".to_string(), serde_json::json!(false));
            }
        }
    }

    ctx.edges.extend(new_edges);
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
        // `extern "ABI" { ... }` declares real FFI symbols (fns/statics) that
        // other code calls/reads — not transparent.
        syn::Item::ForeignMod(fm) => walk_foreign_mod(fm, ctx),
        // Transparent items — no graph nodes needed
        syn::Item::ExternCrate(_) => {}
        syn::Item::Macro(_) => {}
        syn::Item::Union(u) => walk_union(u, ctx),
        syn::Item::TraitAlias(_) => {}
        syn::Item::Verbatim(_) => {}
        _ => ctx.warn_unhandled("Item", item_variant_name(item)),
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

    let mut fn_meta = HashMap::from([
        Ctx::meta_text("visibility", vis_to_text(&f.vis)),
        Ctx::meta_bool("async", f.sig.asyncness.is_some()),
        Ctx::meta_bool("unsafe", f.sig.unsafety.is_some()),
        Ctx::meta_bool("const", f.sig.constness.is_some()),
    ]);
    // Store return type from signature (purely syntactic, not derived)
    if let syn::ReturnType::Type(_, ty) = &f.sig.output {
        let return_type = type_to_name(ty);
        if return_type != "<type>" {
            let (k, v) = Ctx::meta_text("returnType", &return_type);
            fn_meta.insert(k, v);
        }
    }
    ctx.emit_declaration(GraphNode {
        id: node_id.clone(),
        node_type: "FUNCTION".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line, end_column: end_col,
        exported: is_exported,
        metadata: fn_meta,
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
    ctx.push_scope(&node_id, ScopeKind::Function);
    walk_block(&f.block, ctx);
    ctx.pop_scope();
    ctx.enclosing_fn = prev_fn;
}

fn walk_fn_param(param: &syn::FnArg, fn_id: &str, ctx: &mut Ctx) {
    match param {
        syn::FnArg::Receiver(r) => {
            let (line, col) = ctx.span_line_col(r.self_token.span);
            let node_id = semantic_id(&ctx.file, "PARAMETER", "self", Some(fn_id), None);
            ctx.emit_declaration(GraphNode {
                id: node_id,
                node_type: "PARAMETER".to_string(),
                name: "self".to_string(),
                file: ctx.file.clone(),
                line, column: col,
                end_line: ctx.span_end_line_col(r.self_token.span).0, end_column: ctx.span_end_line_col(r.self_token.span).1,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_bool("mutable", r.mutability.is_some()),
                    Ctx::meta_bool("reference", r.reference.is_some()),
                ]),
                extra: HashMap::new(),
            });
        }
        syn::FnArg::Typed(t) => {
            let prev_fn = ctx.enclosing_fn.replace(fn_id.to_string());
            // Thread type annotation through to PARAMETER node metadata
            let type_str = type_to_name(&t.ty);
            if type_str != "<type>" {
                ctx.pending_type_annotation = Some(type_str);
            }
            walk_pat_bindings(t.pat.as_ref(), "param", ctx);
            ctx.pending_type_annotation = None;
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

    ctx.emit_declaration(GraphNode {
        id: node_id.clone(),
        node_type: "VARIABLE".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: ctx.span_end_line_col(c.ident.span()).0, end_column: ctx.span_end_line_col(c.ident.span()).1,
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

    ctx.emit_declaration(GraphNode {
        id: node_id.clone(),
        node_type: "VARIABLE".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: ctx.span_end_line_col(s.ident.span()).0, end_column: ctx.span_end_line_col(s.ident.span()).1,
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

    ctx.emit_declaration(GraphNode {
        id: node_id.clone(),
        node_type: "STRUCT".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: ctx.span_end_line_col(s.ident.span()).0, end_column: ctx.span_end_line_col(s.ident.span()).1,
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
            let mut field_meta = HashMap::new();
            let type_str = type_to_name(&field.ty);
            if type_str != "<type>" {
                field_meta.insert("typeAnnotation".to_string(), serde_json::Value::String(type_str));
            }
            ctx.emit_declaration(GraphNode {
                id: field_id.clone(),
                node_type: "RECORD_FIELD".to_string(),
                name: fname,
                file: ctx.file.clone(),
                line: fl, column: fc,
                end_line: ctx.span_end_line_col(ident.span()).0, end_column: ctx.span_end_line_col(ident.span()).1,
                exported: false,
                metadata: field_meta,
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

/// Walk a Rust `union` declaration.
///
/// Unions are struct-like aggregate types with the same named-field layout, so
/// we model them as STRUCT nodes — this lets every struct-aware query, the
/// layout pass, and the city-map placeable-type list pick them up without
/// introducing a new node type (which would have to be kept in sync across
/// `analyzer.rs`, `layout/loader.rs`, and the GUI's placeable set). The
/// union/struct distinction is preserved in `metadata.declKind = "union"`.
fn walk_union(u: &syn::ItemUnion, ctx: &mut Ctx) {
    let ident = u.ident.to_string();
    let (line, col) = ctx.span_line_col(u.ident.span());
    let is_exported = is_pub(&u.vis);
    let node_id = semantic_id(&ctx.file, "STRUCT", &ident, None, None);

    ctx.emit_declaration(GraphNode {
        id: node_id.clone(),
        node_type: "STRUCT".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: ctx.span_end_line_col(u.ident.span()).0, end_column: ctx.span_end_line_col(u.ident.span()).1,
        exported: is_exported,
        metadata: HashMap::from([
            Ctx::meta_text("visibility", vis_to_text(&u.vis)),
            Ctx::meta_text("declKind", "union"),
        ]),
        extra: HashMap::new(),
    });

    if is_exported {
        ctx.exports.push(ExportInfo {
            name: ident, node_id: node_id.clone(), kind: "union".to_string(), source: None,
        });
    }

    // Fields — a union always has named fields.
    for field in &u.fields.named {
        if let Some(ident) = &field.ident {
            let fname = ident.to_string();
            let (fl, fc) = ctx.span_line_col(ident.span());
            let field_id = semantic_id(&ctx.file, "RECORD_FIELD", &fname, Some(&node_id), None);
            let mut field_meta = HashMap::new();
            let type_str = type_to_name(&field.ty);
            if type_str != "<type>" {
                field_meta.insert("typeAnnotation".to_string(), serde_json::Value::String(type_str));
            }
            ctx.emit_declaration(GraphNode {
                id: field_id.clone(),
                node_type: "RECORD_FIELD".to_string(),
                name: fname,
                file: ctx.file.clone(),
                line: fl, column: fc,
                end_line: ctx.span_end_line_col(ident.span()).0, end_column: ctx.span_end_line_col(ident.span()).1,
                exported: false,
                metadata: field_meta,
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

    ctx.emit_declaration(GraphNode {
        id: node_id.clone(),
        node_type: "ENUM".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: ctx.span_end_line_col(e.ident.span()).0, end_column: ctx.span_end_line_col(e.ident.span()).1,
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
        ctx.emit_declaration(GraphNode {
            id: variant_id,
            node_type: "VARIANT".to_string(),
            name: vname,
            file: ctx.file.clone(),
            line: vl, column: vc,
            end_line: ctx.span_end_line_col(variant.ident.span()).0, end_column: ctx.span_end_line_col(variant.ident.span()).1,
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
        end_line: ctx.span_end_line_col(i.impl_token.span).0, end_column: ctx.span_end_line_col(i.impl_token.span).1,
        exported: false,
        metadata: if let Some(t) = &trait_name {
            HashMap::from([Ctx::meta_text("trait", t)])
        } else {
            HashMap::new()
        },
        extra: HashMap::new(),
    });

    let prev_trait = ctx.enclosing_trait.take();
    ctx.enclosing_trait = trait_name;
    ctx.push_scope(&node_id, ScopeKind::Impl);
    for impl_item in &i.items {
        walk_impl_item(impl_item, ctx);
    }
    ctx.pop_scope();
    ctx.enclosing_trait = prev_trait;
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

            let mut method_meta = HashMap::from([
                Ctx::meta_text("visibility", vis_to_text(&m.vis)),
                Ctx::meta_bool("async", m.sig.asyncness.is_some()),
                Ctx::meta_bool("unsafe", m.sig.unsafety.is_some()),
            ]);
            if let syn::ReturnType::Type(_, ty) = &m.sig.output {
                let return_type = type_to_name(ty);
                if return_type != "<type>" {
                    let (k, v) = Ctx::meta_text("returnType", &return_type);
                    method_meta.insert(k, v);
                }
            }
            // Tag impl-of-trait methods with the trait name so that dyn/impl Trait
            // dispatch resolution can build a TraitMethodIndex without graph traversal.
            if let Some(trait_name) = &ctx.enclosing_trait {
                method_meta.insert("trait".to_string(), serde_json::json!(trait_name));
            }
            ctx.emit_declaration(GraphNode {
                id: node_id.clone(),
                node_type: "FUNCTION".to_string(),
                name: ident.clone(),
                file: ctx.file.clone(),
                line, column: col,
                end_line, end_column: end_col,
                exported: is_exported,
                metadata: method_meta,
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
            ctx.push_scope(&node_id, ScopeKind::Function);
            walk_block(&m.block, ctx);
            ctx.pop_scope();
            ctx.enclosing_fn = prev_fn;
        }
        syn::ImplItem::Const(c) => {
            emit_assoc_const(&c.ident, Some(&c.vis), ctx);
            // Walk the initializer so the constant's value expression (calls,
            // references, literals) participates in the graph like a free const.
            walk_expr(&c.expr, ctx);
        }
        syn::ImplItem::Type(t) => {
            emit_assoc_type(&t.ident, Some(&t.vis), ctx);
        }
        syn::ImplItem::Macro(_) => {}
        syn::ImplItem::Verbatim(_) => {}
        _ => ctx.warn_unhandled("ImplItem", ""),
    }
}

fn walk_trait(t: &syn::ItemTrait, ctx: &mut Ctx) {
    let ident = t.ident.to_string();
    let (line, col) = ctx.span_line_col(t.ident.span());
    let is_exported = is_pub(&t.vis);
    let node_id = semantic_id(&ctx.file, "TRAIT", &ident, None, None);

    ctx.emit_declaration(GraphNode {
        id: node_id.clone(),
        node_type: "TRAIT".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: ctx.span_end_line_col(t.ident.span()).0, end_column: ctx.span_end_line_col(t.ident.span()).1,
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

    ctx.push_scope(&node_id, ScopeKind::Trait);
    for trait_item in &t.items {
        match trait_item {
            syn::TraitItem::Fn(m) => {
                let mname = m.sig.ident.to_string();
                let (ml, mc) = ctx.span_line_col(m.sig.ident.span());
                let sig_id = semantic_id(&ctx.file, "TYPE_SIGNATURE", &mname, Some(&node_id), None);
                ctx.emit_node(GraphNode {
                    id: sig_id,
                    node_type: "TYPE_SIGNATURE".to_string(),
                    name: mname,
                    file: ctx.file.clone(),
                    line: ml, column: mc,
                    end_line: ctx.span_end_line_col(m.sig.ident.span()).0, end_column: ctx.span_end_line_col(m.sig.ident.span()).1,
                    exported: false,
                    metadata: HashMap::new(),
                    extra: HashMap::new(),
                });
            }
            // Trait items have no visibility (they are part of the trait's public
            // contract), hence `None`.
            syn::TraitItem::Const(c) => {
                emit_assoc_const(&c.ident, None, ctx);
                // A trait const may carry a default value: `const N: u32 = 0;`.
                if let Some((_, expr)) = &c.default {
                    walk_expr(expr, ctx);
                }
            }
            syn::TraitItem::Type(ty) => {
                emit_assoc_type(&ty.ident, None, ctx);
            }
            _ => {}
        }
    }
    ctx.pop_scope();
}

/// Emit a VARIABLE node for an associated constant (`const NAME: T [= ...];`)
/// declared inside an `impl` block or `trait`. Mirrors the free-`const` modelling
/// (walk_const) — node type VARIABLE, `kind: "const"`, `mutable: false` — but is
/// parented to the enclosing impl/trait scope via the auto CONTAINS + DECLARES
/// edges (emit_declaration) and tagged `associated: true` so queries can tell
/// `Self::NAME` constants apart from free constants. `vis` is `Some` for impl
/// items (which carry visibility) and `None` for trait items (which do not).
fn emit_assoc_const(ident: &syn::Ident, vis: Option<&syn::Visibility>, ctx: &mut Ctx) {
    let name = ident.to_string();
    let (line, col) = ctx.span_line_col(ident.span());
    let parent = ctx.scope_id().to_string();
    let node_id = semantic_id(&ctx.file, "VARIABLE", &name, Some(&parent), None);

    let mut metadata = HashMap::from([
        Ctx::meta_text("kind", "const"),
        Ctx::meta_bool("mutable", false),
        Ctx::meta_bool("associated", true),
    ]);
    if let Some(v) = vis {
        let (k, val) = Ctx::meta_text("visibility", vis_to_text(v));
        metadata.insert(k, val);
    }

    ctx.emit_declaration(GraphNode {
        id: node_id,
        node_type: "VARIABLE".to_string(),
        name,
        file: ctx.file.clone(),
        line, column: col,
        end_line: ctx.span_end_line_col(ident.span()).0, end_column: ctx.span_end_line_col(ident.span()).1,
        exported: vis.map(is_pub).unwrap_or(false),
        metadata,
        extra: HashMap::new(),
    });
}

/// Emit a TYPE_ALIAS node for an associated type (`type NAME [= ...];`) declared
/// inside an `impl` block or `trait`. Mirrors the free type-alias modelling
/// (walk_type_alias) but is parented to the enclosing impl/trait scope and tagged
/// `associated: true`. `vis` is `Some` for impl items and `None` for trait items.
fn emit_assoc_type(ident: &syn::Ident, vis: Option<&syn::Visibility>, ctx: &mut Ctx) {
    let name = ident.to_string();
    let (line, col) = ctx.span_line_col(ident.span());
    let parent = ctx.scope_id().to_string();
    let node_id = semantic_id(&ctx.file, "TYPE_ALIAS", &name, Some(&parent), None);

    ctx.emit_declaration(GraphNode {
        id: node_id,
        node_type: "TYPE_ALIAS".to_string(),
        name,
        file: ctx.file.clone(),
        line, column: col,
        end_line: ctx.span_end_line_col(ident.span()).0, end_column: ctx.span_end_line_col(ident.span()).1,
        exported: vis.map(is_pub).unwrap_or(false),
        metadata: HashMap::from([Ctx::meta_bool("associated", true)]),
        extra: HashMap::new(),
    });
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
    ctx.emit_declaration(GraphNode {
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
    ctx.emit_declaration(GraphNode {
        id: node_id,
        node_type: "TYPE_ALIAS".to_string(),
        name: ident,
        file: ctx.file.clone(),
        line, column: col,
        end_line: ctx.span_end_line_col(t.ident.span()).0, end_column: ctx.span_end_line_col(t.ident.span()).1,
        exported: is_pub(&t.vis),
        metadata: HashMap::new(),
        extra: HashMap::new(),
    });
}

// ---------------------------------------------------------------------------
// Foreign (FFI) declarations — `extern "ABI" { ... }`
// ---------------------------------------------------------------------------

/// Walk an `extern "ABI" { ... }` foreign module.
///
/// Foreign items are *declarations without bodies*: the functions and statics
/// they introduce are real symbols that other code calls / reads, so they must
/// appear in the graph — otherwise every call into FFI is a dangling,
/// unresolvable edge. Each item is modelled like its in-Rust counterpart
/// (foreign `fn` → FUNCTION, foreign `static` → VARIABLE kind=static, foreign
/// opaque `type` → TYPE_ALIAS) and tagged `metadata["foreign"] = true` plus the
/// block's `abi`, so queries can distinguish FFI symbols. There is no body to
/// walk; parameter nodes (and their type annotations) are still emitted so the
/// signature is queryable.
fn walk_foreign_mod(fm: &syn::ItemForeignMod, ctx: &mut Ctx) {
    // `extern { ... }` with no explicit ABI string defaults to "C".
    let abi = fm
        .abi
        .name
        .as_ref()
        .map(|s| s.value())
        .unwrap_or_else(|| "C".to_string());
    for item in &fm.items {
        match item {
            syn::ForeignItem::Fn(f) => walk_foreign_fn(f, &abi, ctx),
            syn::ForeignItem::Static(s) => walk_foreign_static(s, &abi, ctx),
            syn::ForeignItem::Type(t) => walk_foreign_type(t, ctx),
            // A foreign macro expands at a different stage and a verbatim item is
            // unparsed tokens — neither introduces a resolvable symbol here.
            syn::ForeignItem::Macro(_) => {}
            syn::ForeignItem::Verbatim(_) => {}
            _ => ctx.warn_unhandled("ForeignItem", ""),
        }
    }
}

/// Foreign function declaration (`extern` block `fn`). Mirrors `walk_fn` but has
/// no body: emits a FUNCTION node tagged `foreign`/`abi` and walks the signature
/// parameters. Registered in the enclosing (module) scope so same-file calls
/// resolve to it via the deferred-CALLS scope walk.
fn walk_foreign_fn(f: &syn::ForeignItemFn, abi: &str, ctx: &mut Ctx) {
    let ident = f.sig.ident.to_string();
    let (line, col) = ctx.span_line_col(f.sig.ident.span());
    let (end_line, end_col) = ctx.span_end_line_col(f.sig.ident.span());
    let is_exported = is_pub(&f.vis);
    let node_id = semantic_id(&ctx.file, "FUNCTION", &ident, None, None);

    let mut fn_meta = HashMap::from([
        Ctx::meta_text("visibility", vis_to_text(&f.vis)),
        Ctx::meta_bool("async", f.sig.asyncness.is_some()),
        Ctx::meta_bool("unsafe", f.sig.unsafety.is_some()),
        Ctx::meta_bool("const", f.sig.constness.is_some()),
        Ctx::meta_bool("foreign", true),
        Ctx::meta_text("abi", abi),
    ]);
    if let syn::ReturnType::Type(_, ty) = &f.sig.output {
        let return_type = type_to_name(ty);
        if return_type != "<type>" {
            let (k, v) = Ctx::meta_text("returnType", &return_type);
            fn_meta.insert(k, v);
        }
    }
    ctx.emit_declaration(GraphNode {
        id: node_id.clone(),
        node_type: "FUNCTION".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line, end_column: end_col,
        exported: is_exported,
        metadata: fn_meta,
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

    // No body — walk only the signature parameters.
    for param in &f.sig.inputs {
        walk_fn_param(param, &node_id, ctx);
    }
}

/// Foreign static declaration (`extern` block `static`). Mirrors `walk_static`
/// but has no initializer: emits a VARIABLE node (kind=static) tagged `foreign`.
fn walk_foreign_static(s: &syn::ForeignItemStatic, abi: &str, ctx: &mut Ctx) {
    let ident = s.ident.to_string();
    let (line, col) = ctx.span_line_col(s.ident.span());
    let (end_line, end_col) = ctx.span_end_line_col(s.ident.span());
    let is_exported = is_pub(&s.vis);
    let is_mut = matches!(s.mutability, syn::StaticMutability::Mut(_));
    let node_id = semantic_id(&ctx.file, "VARIABLE", &ident, None, None);

    ctx.emit_declaration(GraphNode {
        id: node_id.clone(),
        node_type: "VARIABLE".to_string(),
        name: ident.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line, end_column: end_col,
        exported: is_exported,
        metadata: HashMap::from([
            Ctx::meta_text("kind", "static"),
            Ctx::meta_bool("mutable", is_mut),
            Ctx::meta_text("visibility", vis_to_text(&s.vis)),
            Ctx::meta_bool("foreign", true),
            Ctx::meta_text("abi", abi),
        ]),
        extra: HashMap::new(),
    });

    if is_exported {
        ctx.exports.push(ExportInfo {
            name: ident, node_id, kind: "variable".to_string(), source: None,
        });
    }
}

/// Foreign opaque type declaration (`extern` block `type Foo;`). Mirrors
/// `walk_type_alias` but the type has no aliased target; tagged `foreign`.
fn walk_foreign_type(t: &syn::ForeignItemType, ctx: &mut Ctx) {
    let ident = t.ident.to_string();
    let (line, col) = ctx.span_line_col(t.ident.span());
    let (end_line, end_col) = ctx.span_end_line_col(t.ident.span());
    ctx.emit_declaration(GraphNode {
        id: semantic_id(&ctx.file, "TYPE_ALIAS", &ident, None, None),
        node_type: "TYPE_ALIAS".to_string(),
        name: ident,
        file: ctx.file.clone(),
        line, column: col,
        end_line, end_column: end_col,
        exported: is_pub(&t.vis),
        metadata: HashMap::from([Ctx::meta_bool("foreign", true)]),
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
        syn::Stmt::Macro(m) => walk_macro(&m.mac, ctx),
    }
}

fn walk_let(local: &syn::Local, ctx: &mut Ctx) {
    // Collect binding IDs before walking init (for ASSIGNED_FROM)
    let binding_ids = collect_pat_binding_ids(&local.pat, "let", ctx);

    // Note: Variable type inference from `let x = Type::method(...)` is now
    // performed by the resolver via ASSIGNED_FROM graph traversal, not by
    // storing derived metadata here. We only keep typeAnnotation for
    // explicitly annotated patterns: `let x: Type = ...`.
    walk_pat_bindings(&local.pat, "let", ctx);

    if let Some(init) = &local.init {
        walk_expr(&init.expr, ctx);

        // ASSIGNED_FROM edges: each binding ← init expression
        // For simple expressions (path, lit), emit direct edge
        if let Some(init_node_id) = expr_node_id(&init.expr, ctx) {
            for var_id in &binding_ids {
                ctx.emit_edge(GraphEdge {
                    src: var_id.clone(),
                    dst: init_node_id.clone(),
                    edge_type: "ASSIGNED_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            }
        }
    }
}

/// Walk a Rust macro invocation: `name!(...)`, `name![...]`, or `name!{...}`.
///
/// `syn` does not expand macros, so the body is an opaque `TokenStream` rather
/// than a parsed AST. We model the invocation itself as a CALL node tagged
/// `macro=true` — honouring the KNOWN_LIMITATIONS contract that "macro
/// invocations appear as CALL nodes" and letting downstream passes tell a
/// macro call apart from a real function call. We do NOT defer a CALLS
/// reference for the macro name: `foo!` is not the function `foo`.
///
/// Best-effort, we then parse the body as a comma-separated expression list and
/// walk each argument, so calls/references nested inside common function-like
/// macros (`vec![a(), b]`, `println!("{}", compute())`, `assert_eq!(x, y())`)
/// are still recorded in the graph — otherwise they would be silently lost.
/// Macros whose body is not an expression list (e.g. `matches!`, `quote!`)
/// simply contribute no argument edges; the parse failure is swallowed, never
/// a panic.
fn walk_macro(mac: &syn::Macro, ctx: &mut Ctx) {
    let name = path_to_string(&mac.path);
    let span = mac.path.segments.last()
        .map(|s| s.ident.span())
        .unwrap_or_else(Span::call_site);
    let (line, col) = ctx.span_line_col(span);
    let parent = ctx.enclosing_fn.as_deref();
    let hash = ctx.pos_hash(line, col);
    let node_id = semantic_id(&ctx.file, "CALL", &name, parent, Some(&hash));
    let (end_line, end_col) = ctx.span_end_line_col(span);

    ctx.emit_node(GraphNode {
        id: node_id.clone(),
        node_type: "CALL".to_string(),
        name: name.clone(),
        file: ctx.file.clone(),
        line, column: col,
        end_line, end_column: end_col,
        exported: false,
        metadata: HashMap::from([
            Ctx::meta_bool("method", false),
            Ctx::meta_bool("macro", true),
        ]),
        extra: HashMap::new(),
    });

    // Best-effort argument walking; non-expression bodies are skipped safely.
    if let Ok(args) = mac.parse_body_with(
        syn::punctuated::Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated,
    ) {
        for (i, arg) in args.iter().enumerate() {
            walk_expr(arg, ctx);
            if let Some(arg_id) = expr_node_id(arg, ctx) {
                ctx.emit_edge(GraphEdge {
                    src: node_id.clone(),
                    dst: arg_id,
                    edge_type: "PASSES_ARGUMENT".to_string(),
                    metadata: HashMap::from([Ctx::meta_int("index", i as i64)]),
                });
            }
        }
    }
}

/// Predict binding IDs that walk_pat_bindings will create (without emitting).
fn collect_pat_binding_ids(pat: &syn::Pat, kind: &str, ctx: &Ctx) -> Vec<String> {
    let mut ids = Vec::new();
    collect_pat_ids_inner(pat, kind, ctx, &mut ids);
    ids
}

fn collect_pat_ids_inner(pat: &syn::Pat, kind: &str, ctx: &Ctx, ids: &mut Vec<String>) {
    match pat {
        syn::Pat::Ident(pi) => {
            let name = pi.ident.to_string();
            let (line, col) = ctx.span_line_col(pi.ident.span());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_type = if kind == "param" { "PARAMETER" } else { "VARIABLE" };
            ids.push(semantic_id(&ctx.file, node_type, &name, parent, Some(&hash)));
            if let Some(sub) = &pi.subpat {
                collect_pat_ids_inner(&sub.1, kind, ctx, ids);
            }
        }
        syn::Pat::Tuple(t) => { for p in &t.elems { collect_pat_ids_inner(p, kind, ctx, ids); } }
        syn::Pat::TupleStruct(ts) => { for p in &ts.elems { collect_pat_ids_inner(p, kind, ctx, ids); } }
        syn::Pat::Struct(s) => { for f in &s.fields { collect_pat_ids_inner(&f.pat, kind, ctx, ids); } }
        syn::Pat::Slice(s) => { for p in &s.elems { collect_pat_ids_inner(p, kind, ctx, ids); } }
        syn::Pat::Or(o) => { for p in &o.cases { collect_pat_ids_inner(p, kind, ctx, ids); } }
        syn::Pat::Reference(r) => collect_pat_ids_inner(&r.pat, kind, ctx, ids),
        syn::Pat::Type(t) => collect_pat_ids_inner(&t.pat, kind, ctx, ids),
        syn::Pat::Paren(p) => collect_pat_ids_inner(&p.pat, kind, ctx, ids),
        _ => {} // wild, rest, lit, range, etc. — no bindings
    }
}

/// Get the most recent node ID for an expression (for data flow edges).
fn expr_node_id(expr: &syn::Expr, ctx: &Ctx) -> Option<String> {
    match expr {
        syn::Expr::Path(p) if p.path.segments.len() == 1 => {
            let name = p.path.segments[0].ident.to_string();
            let (line, col) = ctx.span_line_col(p.path.segments[0].ident.span());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            Some(semantic_id(&ctx.file, "REFERENCE", &name, parent, Some(&hash)))
        }
        syn::Expr::Call(c) => {
            let name = expr_to_name(&c.func);
            let (line, col) = ctx.span_line_col(c.paren_token.span.join());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            Some(semantic_id(&ctx.file, "CALL", &name, parent, Some(&hash)))
        }
        syn::Expr::MethodCall(m) => {
            let name = m.method.to_string();
            let (line, col) = ctx.span_line_col(m.method.span());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            Some(semantic_id(&ctx.file, "CALL", &name, parent, Some(&hash)))
        }
        syn::Expr::Field(f) => {
            let member = match &f.member {
                syn::Member::Named(i) => i.to_string(),
                syn::Member::Unnamed(i) => i.index.to_string(),
            };
            let (line, col) = ctx.span_line_col(f.dot_token.span);
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            Some(semantic_id(&ctx.file, "PROPERTY_ACCESS", &member, parent, Some(&hash)))
        }
        syn::Expr::Reference(r) => expr_node_id(&r.expr, ctx),
        syn::Expr::Paren(p) => expr_node_id(&p.expr, ctx),
        syn::Expr::Try(t) => expr_node_id(&t.expr, ctx),
        syn::Expr::Await(a) => expr_node_id(&a.base, ctx),
        syn::Expr::Unary(u) => expr_node_id(&u.expr, ctx),
        syn::Expr::Block(b) => {
            // Block expression returns its last expression
            b.block.stmts.last().and_then(|s| match s {
                syn::Stmt::Expr(e, _) => expr_node_id(e, ctx),
                _ => None,
            })
        }
        syn::Expr::If(i) => {
            // if-else expression returns from then branch
            i.then_branch.stmts.last().and_then(|s| match s {
                syn::Stmt::Expr(e, _) => expr_node_id(e, ctx),
                _ => None,
            })
        }
        syn::Expr::Lit(l) => {
            let (line, col) = ctx.span_line_col(l.lit.span());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            Some(semantic_id(&ctx.file, "LITERAL", &lit_to_name(&l.lit), parent, Some(&hash)))
        }
        _ => None,
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

            let mut meta = HashMap::from([
                Ctx::meta_text("kind", kind),
                Ctx::meta_bool("mutable", pi.mutability.is_some()),
            ]);
            if let Some(ref ty) = ctx.pending_type_annotation {
                let (k, v) = Ctx::meta_text("typeAnnotation", ty);
                meta.insert(k, v);
            }
            ctx.emit_declaration(GraphNode {
                id: node_id,
                node_type: node_type.to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col,
                end_line: ctx.span_end_line_col(pi.ident.span()).0, end_column: ctx.span_end_line_col(pi.ident.span()).1,
                exported: false,
                metadata: meta,
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
            // `x: i32` — extract type annotation and thread to inner pattern
            let prev = ctx.pending_type_annotation.take();
            let type_str = type_to_name(&pt.ty);
            if type_str != "<type>" {
                ctx.pending_type_annotation = Some(type_str);
            }
            walk_pat_bindings(&pt.pat, kind, ctx);
            ctx.pending_type_annotation = prev;
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
        _ => ctx.warn_unhandled("Pat", ""),
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
                id: node_id.clone(),
                node_type: "CALL".to_string(),
                name: func_name.clone(),
                file: ctx.file.clone(),
                line, column: col,
                end_line: ctx.span_end_line_col(e.paren_token.span.join()).0, end_column: ctx.span_end_line_col(e.paren_token.span.join()).1,
                exported: false,
                metadata: HashMap::from([Ctx::meta_bool("method", false)]),
                extra: HashMap::new(),
            });

            // Defer CALLS resolution for simple function names
            if let syn::Expr::Path(p) = e.func.as_ref() {
                if p.path.segments.len() == 1 {
                    ctx.defer_ref(&func_name, &node_id, "CALLS");
                }
            }

            walk_expr(&e.func, ctx);
            for (i, arg) in e.args.iter().enumerate() {
                walk_expr(arg, ctx);
                if let Some(arg_id) = expr_node_id(arg, ctx) {
                    ctx.emit_edge(GraphEdge {
                        src: node_id.clone(),
                        dst: arg_id,
                        edge_type: "PASSES_ARGUMENT".to_string(),
                        metadata: HashMap::from([Ctx::meta_int("index", i as i64)]),
                    });
                }
            }
        }

        syn::Expr::MethodCall(e) => {
            let method = e.method.to_string();
            let (line, col) = ctx.span_line_col(e.method.span());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "CALL", &method, parent, Some(&hash));

            let mut call_meta = HashMap::from([
                Ctx::meta_bool("method", true),
                Ctx::meta_text("receiver", &expr_to_name(&e.receiver)),
            ]);
            if is_self_field_access(&e.receiver) {
                call_meta.insert("selfField".to_string(), serde_json::Value::Bool(true));
            }
            ctx.emit_node(GraphNode {
                id: node_id.clone(),
                node_type: "CALL".to_string(),
                name: method,
                file: ctx.file.clone(),
                line, column: col,
                end_line: ctx.span_end_line_col(e.method.span()).0, end_column: ctx.span_end_line_col(e.method.span()).1,
                exported: false,
                metadata: call_meta,
                extra: HashMap::new(),
            });

            // READS_FROM: method call reads the receiver.
            // Try direct edge first (for chains like a.b.c()), fall back to deferred.
            let receiver_name = expr_to_name(&e.receiver);
            if let Some(recv_id) = expr_node_id(&e.receiver, ctx) {
                ctx.emit_edge(GraphEdge {
                    src: node_id.clone(),
                    dst: recv_id,
                    edge_type: "READS_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            } else {
                ctx.defer_ref(&receiver_name, &node_id, "READS_FROM");
            }

            walk_expr(&e.receiver, ctx);
            for (i, arg) in e.args.iter().enumerate() {
                walk_expr(arg, ctx);
                if let Some(arg_id) = expr_node_id(arg, ctx) {
                    ctx.emit_edge(GraphEdge {
                        src: node_id.clone(),
                        dst: arg_id,
                        edge_type: "PASSES_ARGUMENT".to_string(),
                        metadata: HashMap::from([Ctx::meta_int("index", i as i64)]),
                    });
                }
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
                id: node_id.clone(),
                node_type: "REFERENCE".to_string(),
                name: name.clone(),
                file: ctx.file.clone(),
                line, column: col,
                end_line: ctx.span_end_line_col(e.path.segments.last().map(|s| s.ident.span()).unwrap_or_else(Span::call_site)).0, end_column: ctx.span_end_line_col(e.path.segments.last().map(|s| s.ident.span()).unwrap_or_else(Span::call_site)).1,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            });

            // Defer scope resolution: REFERENCE → READS_FROM → declaration
            // Only for simple names (not paths like std::io)
            if e.path.segments.len() == 1 {
                ctx.defer_ref(&name, &node_id, "READS_FROM");
            }
        }

        syn::Expr::Field(e) => {
            let member = match &e.member {
                syn::Member::Named(i) => i.to_string(),
                syn::Member::Unnamed(i) => i.index.to_string(),
            };
            let receiver_name = expr_to_name(&e.base);
            let (line, col) = ctx.span_line_col(e.dot_token.span);
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "PROPERTY_ACCESS", &member, parent, Some(&hash));

            ctx.emit_node(GraphNode {
                id: node_id.clone(),
                node_type: "PROPERTY_ACCESS".to_string(),
                name: member,
                file: ctx.file.clone(),
                line, column: col,
                end_line: ctx.span_end_line_col(e.dot_token.span).0, end_column: ctx.span_end_line_col(e.dot_token.span).1,
                exported: false,
                metadata: HashMap::from([
                    Ctx::meta_text("receiver", &receiver_name),
                ]),
                extra: HashMap::new(),
            });

            // READS_FROM: property access reads the receiver.
            if let Some(recv_id) = expr_node_id(&e.base, ctx) {
                ctx.emit_edge(GraphEdge {
                    src: node_id.clone(),
                    dst: recv_id,
                    edge_type: "READS_FROM".to_string(),
                    metadata: HashMap::new(),
                });
            } else {
                ctx.defer_ref(&receiver_name, &node_id, "READS_FROM");
            }

            walk_expr(&e.base, ctx);
        }

        // ── BRANCH nodes with block scopes ──────────────────────────
        syn::Expr::If(e) => {
            let (line, col) = ctx.span_line_col(e.if_token.span);
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "BRANCH", "if", parent, Some(&hash));
            let scope_id = semantic_id(&ctx.file, "SCOPE", "if", parent, Some(&hash));
            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "BRANCH".to_string(),
                name: "if".to_string(),
                file: ctx.file.clone(),
                line, column: col,
                end_line: ctx.span_end_line_col(e.if_token.span).0, end_column: ctx.span_end_line_col(e.if_token.span).1,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "if")]),
                extra: HashMap::new(),
            });
            walk_expr(&e.cond, ctx);
            ctx.push_scope_with_span(&scope_id, ScopeKind::Block, Some(e.then_branch.brace_token.span.join()));
            walk_block(&e.then_branch, ctx);
            ctx.pop_scope();
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
                id: node_id.clone(),
                node_type: "BRANCH".to_string(),
                name: "match".to_string(),
                file: ctx.file.clone(),
                line, column: col,
                end_line: ctx.span_end_line_col(e.match_token.span).0, end_column: ctx.span_end_line_col(e.match_token.span).1,
                exported: false,
                metadata: HashMap::from([Ctx::meta_text("kind", "match")]),
                extra: HashMap::new(),
            });
            walk_expr(&e.expr, ctx);
            for (arm_idx, arm) in e.arms.iter().enumerate() {
                let arm_hash = content_hash(&[("match", &line.to_string()), ("arm", &arm_idx.to_string())]);
                let arm_scope = semantic_id(&ctx.file, "SCOPE", "match_arm", Some(&node_id), Some(&arm_hash));
                ctx.push_scope(&arm_scope, ScopeKind::Block);
                if let Some(guard) = &arm.guard {
                    walk_expr(guard.1.as_ref(), ctx);
                }
                walk_expr(&arm.body, ctx);
                ctx.pop_scope();
            }
        }

        syn::Expr::Loop(e) => {
            let (line, col) = ctx.span_line_col(e.loop_token.span);
            let (_, scope_id) = emit_branch("loop", line, col, ctx);
            ctx.push_scope_with_span(&scope_id, ScopeKind::Block, Some(e.body.brace_token.span.join()));
            walk_block(&e.body, ctx);
            ctx.pop_scope();
        }
        syn::Expr::While(e) => {
            let (line, col) = ctx.span_line_col(e.while_token.span);
            let (_, scope_id) = emit_branch("while", line, col, ctx);
            walk_expr(&e.cond, ctx);
            ctx.push_scope_with_span(&scope_id, ScopeKind::Block, Some(e.body.brace_token.span.join()));
            walk_block(&e.body, ctx);
            ctx.pop_scope();
        }
        syn::Expr::ForLoop(e) => {
            let (line, col) = ctx.span_line_col(e.for_token.span);
            let (_, scope_id) = emit_branch("for", line, col, ctx);
            walk_expr(&e.expr, ctx);
            ctx.push_scope_with_span(&scope_id, ScopeKind::Block, Some(e.body.brace_token.span.join()));
            walk_block(&e.body, ctx);
            ctx.pop_scope();
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
                end_line: ctx.span_end_line_col(e.or1_token.span).0, end_column: ctx.span_end_line_col(e.or1_token.span).1,
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

        // ── LITERAL nodes ────────────────────────────────────────────
        syn::Expr::Lit(e) => {
            let name = lit_to_name(&e.lit);
            let (line, col) = ctx.span_line_col(e.lit.span());
            let parent = ctx.enclosing_fn.as_deref();
            let hash = ctx.pos_hash(line, col);
            let node_id = semantic_id(&ctx.file, "LITERAL", &name, parent, Some(&hash));
            ctx.emit_node(GraphNode {
                id: node_id,
                node_type: "LITERAL".to_string(),
                name,
                file: ctx.file.clone(),
                line, column: col,
                end_line: ctx.span_end_line_col(e.lit.span()).0, end_column: ctx.span_end_line_col(e.lit.span()).1,
                exported: false,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            });
        }
        syn::Expr::Macro(e) => walk_macro(&e.mac, ctx),
        // Inline `const { ... }` block — walk its body like Unsafe/Async blocks
        // so nested calls/references are not silently dropped from the graph.
        syn::Expr::Const(e) => walk_block(&e.block, ctx),
        syn::Expr::Infer(_) => {}
        syn::Expr::Verbatim(_) => {}

        _ => ctx.warn_unhandled("Expr", ""),
    }
}

/// Returns (branch_node_id, scope_id) — separate IDs so SCOPE node is distinct from BRANCH.
fn emit_branch(kind: &str, line: i64, col: i64, ctx: &mut Ctx) -> (String, String) {
    let parent = ctx.enclosing_fn.as_deref();
    let hash = ctx.pos_hash(line, col);
    let node_id = semantic_id(&ctx.file, "BRANCH", kind, parent, Some(&hash));
    let scope_id = semantic_id(&ctx.file, "SCOPE", kind, parent, Some(&hash));
    ctx.emit_node(GraphNode {
        id: node_id.clone(),
        node_type: "BRANCH".to_string(),
        name: kind.to_string(),
        file: ctx.file.clone(),
        line, column: col,
        end_line: 0, end_column: 0,
        exported: false,
        metadata: HashMap::from([Ctx::meta_text("kind", kind)]),
        extra: HashMap::new(),
    });
    (node_id, scope_id)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn lit_to_name(lit: &syn::Lit) -> String {
    match lit {
        syn::Lit::Str(s) => s.value(),
        syn::Lit::ByteStr(s) => format!("b\"{}\"", String::from_utf8_lossy(&s.value())),
        syn::Lit::CStr(s) => format!("c\"{}\"", s.value().to_string_lossy()),
        syn::Lit::Byte(b) => format!("b'{}'", b.value() as char),
        syn::Lit::Char(c) => format!("'{}'", c.value()),
        syn::Lit::Int(i) => i.base10_digits().to_string(),
        syn::Lit::Float(f) => f.base10_digits().to_string(),
        syn::Lit::Bool(b) => b.value.to_string(),
        syn::Lit::Verbatim(v) => v.to_string(),
        _ => "<lit>".to_string(),
    }
}

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

/// Check if an expression is `self.field` (field access on self).
fn is_self_field_access(expr: &syn::Expr) -> bool {
    if let syn::Expr::Field(f) = expr {
        if let syn::Expr::Path(p) = f.base.as_ref() {
            return p.path.is_ident("self");
        }
    }
    false
}

fn path_to_string(path: &syn::Path) -> String {
    path.segments.iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

/// If `path` is a single-segment `Box<T>`, `Rc<T>`, or `Arc<T>` (optionally
/// fully qualified, e.g. `std::boxed::Box<T>`), return the inner type `T`.
///
/// These are the canonical Deref-transparent owning smart pointers: a method
/// call on a `Box<T>` / `Rc<T>` / `Arc<T>` receiver auto-derefs to `T`, and
/// unsized trait objects (`dyn Trait`) can only exist behind such a pointer.
/// Treating the inner type as the receiver type is therefore what method- and
/// dyn-dispatch resolution needs. Other generic containers (`Vec`, `Option`,
/// `RefCell`, …) are intentionally NOT unwrapped — a method on them belongs to
/// the container, not the element.
fn unwrap_smart_pointer(path: &syn::Path) -> Option<&syn::Type> {
    let seg = path.segments.last()?;
    if !matches!(seg.ident.to_string().as_str(), "Box" | "Rc" | "Arc") {
        return None;
    }
    if let syn::PathArguments::AngleBracketed(args) = &seg.arguments {
        for arg in &args.args {
            if let syn::GenericArgument::Type(inner) = arg {
                return Some(inner);
            }
        }
    }
    None
}

fn type_to_name(ty: &syn::Type) -> String {
    match ty {
        syn::Type::Path(p) => match unwrap_smart_pointer(&p.path) {
            Some(inner) => type_to_name(inner),
            None => path_to_string(&p.path),
        },
        syn::Type::Reference(r) => type_to_name(&r.elem),
        syn::Type::Paren(p) => type_to_name(&p.elem),
        syn::Type::Group(g) => type_to_name(&g.elem),
        syn::Type::Slice(s) => type_to_name(&s.elem),
        syn::Type::TraitObject(t) => {
            for bound in &t.bounds {
                if let syn::TypeParamBound::Trait(tb) = bound {
                    return format!("dyn {}", path_to_string(&tb.path));
                }
            }
            "<type>".to_string()
        }
        syn::Type::ImplTrait(t) => {
            for bound in &t.bounds {
                if let syn::TypeParamBound::Trait(tb) = bound {
                    return format!("impl {}", path_to_string(&tb.path));
                }
            }
            "<type>".to_string()
        }
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
    fn test_inline_const_block_walks_body() {
        // syn::Expr::Const — inline `const { ... }` block expression (Rust 1.79+).
        // Its body is a syn::Block and must be walked like Expr::Unsafe / Expr::Async,
        // otherwise nested calls/references are silently dropped from the call graph.
        let fa = parse_and_analyze(
            "fn main() { let _x = const { helper() }; }  const fn helper() -> i32 { 0 }",
        );
        assert!(
            has_node(&fa, "CALL", "helper"),
            "CALL helper nested in inline const block must be emitted"
        );
    }

    #[test]
    fn test_let_binding() {
        let fa = parse_and_analyze("fn main() { let x = 42; let mut y = x; }");
        assert_eq!(count_nodes(&fa, "VARIABLE"), 2);
        assert!(has_node(&fa, "VARIABLE", "x"));
        assert!(has_node(&fa, "VARIABLE", "y"));
    }

    #[test]
    fn test_type_annotation_on_param() {
        let fa = parse_and_analyze("fn foo(x: i32, seg: NodeSegmentV2) {}");
        let x = fa.nodes.iter().find(|n| n.node_type == "PARAMETER" && n.name == "x").unwrap();
        assert_eq!(x.metadata.get("typeAnnotation"), Some(&serde_json::json!("i32")));
        let seg = fa.nodes.iter().find(|n| n.node_type == "PARAMETER" && n.name == "seg").unwrap();
        assert_eq!(seg.metadata.get("typeAnnotation"), Some(&serde_json::json!("NodeSegmentV2")));
    }

    #[test]
    fn test_type_annotation_on_let() {
        let fa = parse_and_analyze("fn main() { let x: u64 = 42; }");
        let x = fa.nodes.iter().find(|n| n.node_type == "VARIABLE" && n.name == "x").unwrap();
        assert_eq!(x.metadata.get("typeAnnotation"), Some(&serde_json::json!("u64")));
    }

    #[test]
    fn test_type_annotation_reference() {
        let fa = parse_and_analyze("fn foo(seg: &NodeSegmentV2) {}");
        let seg = fa.nodes.iter().find(|n| n.node_type == "PARAMETER" && n.name == "seg").unwrap();
        assert_eq!(seg.metadata.get("typeAnnotation"), Some(&serde_json::json!("NodeSegmentV2")));
    }

    // Trait objects in idiomatic Rust are unsized, so they always appear behind
    // a pointer: `&dyn T`, `Box<dyn T>`, `Rc<dyn T>`, `Arc<dyn T>`. References are
    // already peeled, but the Deref-transparent owning smart pointers must be
    // unwrapped too, otherwise `Box<dyn Draw>` collapses to `"Box"` and the trait
    // name needed for dyn-dispatch resolution is lost.
    #[test]
    fn test_type_annotation_box_dyn_trait() {
        let fa = parse_and_analyze("fn render(x: Box<dyn Draw>) {}");
        let x = fa.nodes.iter().find(|n| n.node_type == "PARAMETER" && n.name == "x").unwrap();
        assert_eq!(x.metadata.get("typeAnnotation"), Some(&serde_json::json!("dyn Draw")));
    }

    #[test]
    fn test_type_annotation_rc_dyn_trait() {
        let fa = parse_and_analyze("fn render(x: Rc<dyn Shape>) {}");
        let x = fa.nodes.iter().find(|n| n.node_type == "PARAMETER" && n.name == "x").unwrap();
        assert_eq!(x.metadata.get("typeAnnotation"), Some(&serde_json::json!("dyn Shape")));
    }

    #[test]
    fn test_type_annotation_arc_dyn_trait() {
        let fa = parse_and_analyze("fn handle(x: Arc<dyn Handler>) {}");
        let x = fa.nodes.iter().find(|n| n.node_type == "PARAMETER" && n.name == "x").unwrap();
        assert_eq!(x.metadata.get("typeAnnotation"), Some(&serde_json::json!("dyn Handler")));
    }

    #[test]
    fn test_type_annotation_fully_qualified_box_dyn_trait() {
        let fa = parse_and_analyze("fn render(x: std::boxed::Box<dyn Draw>) {}");
        let x = fa.nodes.iter().find(|n| n.node_type == "PARAMETER" && n.name == "x").unwrap();
        assert_eq!(x.metadata.get("typeAnnotation"), Some(&serde_json::json!("dyn Draw")));
    }

    #[test]
    fn test_type_annotation_box_concrete_type() {
        // Box<Foo> derefs to Foo, so a method call on it resolves to Foo's impl.
        let fa = parse_and_analyze("fn take(x: Box<Foo>) {}");
        let x = fa.nodes.iter().find(|n| n.node_type == "PARAMETER" && n.name == "x").unwrap();
        assert_eq!(x.metadata.get("typeAnnotation"), Some(&serde_json::json!("Foo")));
    }

    #[test]
    fn test_type_annotation_vec_not_unwrapped() {
        // Vec is NOT a Deref-transparent owning pointer: `v.push()` is a Vec method,
        // not a method on the element type. Vec<String> must stay "Vec".
        let fa = parse_and_analyze("fn take(v: Vec<String>) {}");
        let v = fa.nodes.iter().find(|n| n.node_type == "PARAMETER" && n.name == "v").unwrap();
        assert_eq!(v.metadata.get("typeAnnotation"), Some(&serde_json::json!("Vec")));
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
    fn test_union_with_fields() {
        // Rust `union`s are struct-like: same named-field layout, same role as a
        // declared aggregate type. We emit them as STRUCT nodes (so every
        // struct-aware query, layout pass, and the city-map placeable list pick
        // them up without new node-type plumbing) and tag declKind=union so the
        // union/struct distinction survives in the graph.
        let fa = parse_and_analyze("pub union MyUnion { pub i: u32, f: f32 }");
        assert!(has_node(&fa, "STRUCT", "MyUnion"), "union emitted as STRUCT node");
        assert!(has_node(&fa, "RECORD_FIELD", "i"), "union field i");
        assert!(has_node(&fa, "RECORD_FIELD", "f"), "union field f");
        assert!(has_edge(&fa, "HAS_FIELD", "STRUCT", "RECORD_FIELD"), "HAS_FIELD edge");

        let u = fa.nodes.iter()
            .find(|n| n.node_type == "STRUCT" && n.name == "MyUnion")
            .unwrap();
        assert_eq!(u.metadata.get("declKind"), Some(&serde_json::json!("union")), "tagged declKind=union");
        assert!(u.exported, "pub union is exported");

        // Field type annotations are preserved exactly like struct fields.
        let i = fa.nodes.iter()
            .find(|n| n.node_type == "RECORD_FIELD" && n.name == "i")
            .unwrap();
        assert_eq!(i.metadata.get("typeAnnotation"), Some(&serde_json::json!("u32")));
    }

    #[test]
    fn test_function_return_type() {
        let fa = parse_and_analyze("
            fn make_shard() -> Shard { todo!() }
            fn make_box() -> Box<Vec<u8>> { todo!() }
            fn unit_fn() {}
        ");
        let make_shard = fa.nodes.iter().find(|n| n.node_type == "FUNCTION" && n.name == "make_shard").unwrap();
        assert_eq!(make_shard.metadata.get("returnType"), Some(&serde_json::json!("Shard")));

        // Box<Vec<u8>> derefs to Vec<u8>, so the receiver type is the inner Vec.
        let make_box = fa.nodes.iter().find(|n| n.node_type == "FUNCTION" && n.name == "make_box").unwrap();
        assert_eq!(make_box.metadata.get("returnType"), Some(&serde_json::json!("Vec")));

        let unit_fn = fa.nodes.iter().find(|n| n.node_type == "FUNCTION" && n.name == "unit_fn").unwrap();
        assert!(unit_fn.metadata.get("returnType").is_none());
    }

    #[test]
    fn test_method_return_type() {
        let fa = parse_and_analyze("
            struct Foo;
            impl Foo {
                fn make() -> Foo { Foo }
                fn no_return(&self) {}
            }
        ");
        let make = fa.nodes.iter().find(|n| n.node_type == "FUNCTION" && n.name == "make").unwrap();
        assert_eq!(make.metadata.get("returnType"), Some(&serde_json::json!("Foo")));
    }

    #[test]
    fn test_self_field_method_call() {
        let fa = parse_and_analyze("
            struct Foo { bar: Vec<i32> }
            impl Foo {
                fn baz(&self) {
                    self.bar.push(1);
                    let x = Vec::new();
                    x.push(2);
                }
            }
        ");
        // self.bar.push() should have selfField=true
        let self_call = fa.nodes.iter().find(|n|
            n.node_type == "CALL" && n.name == "push"
            && n.metadata.get("receiver") == Some(&serde_json::json!("bar"))
        ).unwrap();
        assert_eq!(self_call.metadata.get("selfField"), Some(&serde_json::json!(true)));

        // x.push() should NOT have selfField
        let local_call = fa.nodes.iter().find(|n|
            n.node_type == "CALL" && n.name == "push"
            && n.metadata.get("receiver") == Some(&serde_json::json!("x"))
        ).unwrap();
        assert!(local_call.metadata.get("selfField").is_none());
    }

    #[test]
    fn test_struct_field_type_annotation() {
        let fa = parse_and_analyze("struct Shard { segments: Vec<Segment>, name: String }");
        let segments = fa.nodes.iter().find(|n| n.node_type == "RECORD_FIELD" && n.name == "segments").unwrap();
        assert_eq!(segments.metadata.get("typeAnnotation"), Some(&serde_json::json!("Vec")));
        let name = fa.nodes.iter().find(|n| n.node_type == "RECORD_FIELD" && n.name == "name").unwrap();
        assert_eq!(name.metadata.get("typeAnnotation"), Some(&serde_json::json!("String")));
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
    fn test_unhandled_expr_variant_degrades_gracefully() {
        // `&raw const`/`&raw mut` (the raw-reference operator, stable since Rust
        // 1.82) parses as `syn::Expr::RawAddr`, a variant this walker does not
        // recognise, so it falls to the catch-all arm in `walk_expr`. That arm
        // used to `panic!`; because per-file analysis runs inside
        // `spawn_blocking`, the panic was caught upstream and the ENTIRE file was
        // discarded (`analysis: None`, mislabelled `parse_error`).
        //
        // Invariant under test: one unrecognised construct must NOT erase the
        // rest of an otherwise-parseable file. The file is still analysed; the
        // unknown construct is simply skipped.
        let fa = parse_and_analyze(
            "fn make() { let x = 0u8; let p = &raw const x; helper(); } fn helper() {}",
        );
        assert!(has_node(&fa, "MODULE", "test"), "MODULE node survives");
        assert!(has_node(&fa, "FUNCTION", "make"), "FUNCTION make survives");
        assert!(
            has_node(&fa, "FUNCTION", "helper"),
            "sibling FUNCTION helper survives the unhandled RawAddr expr"
        );
        assert!(
            has_node(&fa, "CALL", "helper"),
            "CALL helper after the unhandled expr is still emitted"
        );
    }

    #[test]
    fn test_scope_hierarchy() {
        let fa = parse_and_analyze("fn main() { if true { let x = 1; } }");
        // Block scope for if body
        assert!(has_node(&fa, "SCOPE", "block"), "block scope for if");
        // MODULE → HAS_SCOPE → FUNCTION
        assert!(has_edge(&fa, "HAS_SCOPE", "MODULE", "FUNCTION"), "MODULE HAS_SCOPE FUNCTION");
        // FUNCTION → HAS_SCOPE → SCOPE (if block scope lives under function)
        assert!(has_edge(&fa, "HAS_SCOPE", "FUNCTION", "SCOPE"), "FUNCTION HAS_SCOPE block SCOPE");
        // Variable declared inside if block → DECLARES from block scope
        let decl_in_block: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "DECLARES" && e.dst.contains("VARIABLE"))
            .collect();
        assert!(!decl_in_block.is_empty(), "block scope DECLARES variable");
    }

    #[test]
    fn test_declares_edges() {
        let fa = parse_and_analyze("fn main() { let x = 1; }");
        // Function scope declares x
        let decl_edges: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "DECLARES" && e.dst.contains("VARIABLE"))
            .collect();
        assert!(!decl_edges.is_empty(), "should have DECLARES edge to VARIABLE");
    }

    #[test]
    fn test_reference_resolution() {
        let fa = parse_and_analyze("fn main() { let x = 1; let _y = x; }");
        // REFERENCE "x" should have READS_FROM → VARIABLE "x"
        let refs: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "READS_FROM")
            .collect();
        assert!(!refs.is_empty(), "should have READS_FROM edges, got edges: {:?}",
            fa.edges.iter().map(|e| format!("{} {} -> {}", e.edge_type, &e.src[..20.min(e.src.len())], &e.dst[..20.min(e.dst.len())])).collect::<Vec<_>>());
    }

    #[test]
    fn test_assigned_from() {
        let fa = parse_and_analyze("fn main() { let x = foo(); }");
        let assigned: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "ASSIGNED_FROM")
            .collect();
        assert!(!assigned.is_empty(), "should have ASSIGNED_FROM edges");
    }

    #[test]
    fn test_passes_argument() {
        let fa = parse_and_analyze("fn foo(x: i32) {} fn main() { foo(42); }");
        let passes: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "PASSES_ARGUMENT")
            .collect();
        assert!(!passes.is_empty(), "should have PASSES_ARGUMENT edges");
    }

    #[test]
    fn test_literal_nodes() {
        let fa = parse_and_analyze("fn main() { let x = 42; let s = \"hello\"; }");
        assert!(has_node(&fa, "LITERAL", "42"), "integer literal");
        assert!(has_node(&fa, "LITERAL", "hello"), "string literal");
    }

    #[test]
    fn test_end_positions_present() {
        let fa = parse_and_analyze("fn main() {\n    let x = 42;\n    foo(x);\n}\nfn foo(n: i32) -> i32 {\n    n + 1\n}\n");
        let main_fn = fa.nodes.iter().find(|n| n.node_type == "FUNCTION" && n.name == "main").unwrap();
        assert!(main_fn.end_line > main_fn.line, "FUNCTION should have end_line > line, got line={} end_line={}", main_fn.line, main_fn.end_line);

        let call = fa.nodes.iter().find(|n| n.node_type == "CALL" && n.name == "foo").unwrap();
        assert!(call.line > 0, "CALL should have line > 0, got {}", call.line);

        let var = fa.nodes.iter().find(|n| n.node_type == "VARIABLE" && n.name == "x").unwrap();
        assert!(var.line > 0, "VARIABLE should have line > 0, got {}", var.line);
    }

    #[test]
    fn test_method_chain_trace() {
        let fa = parse_and_analyze(
            "struct Foo; impl Foo { fn bar(&self) -> &Self { self } } \
             fn main() { let f = Foo; let x = f.bar(); }"
        );
        // x ASSIGNED_FROM CALL bar
        let assigned: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "ASSIGNED_FROM" && e.src.contains("VARIABLE") && e.src.contains("x"))
            .collect();
        assert!(!assigned.is_empty(), "x should have ASSIGNED_FROM");
        // CALL bar READS_FROM REFERENCE f
        let reads: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "READS_FROM" && e.src.contains("CALL") && e.src.contains("bar"))
            .collect();
        assert!(!reads.is_empty(), "CALL bar should READS_FROM receiver f");
    }

    #[test]
    fn test_try_operator_chain() {
        // let x = foo()? — Try wraps the call, ASSIGNED_FROM should see through it
        let fa = parse_and_analyze(
            "fn foo() -> Result<i32, ()> { Ok(1) } \
             fn main() -> Result<(), ()> { let x = foo()?; Ok(()) }"
        );
        let assigned: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "ASSIGNED_FROM" && e.src.contains("VARIABLE") && e.src.contains("x"))
            .collect();
        assert!(!assigned.is_empty(), "x should have ASSIGNED_FROM (through ?)");
        // The ASSIGNED_FROM dst should be the CALL foo (not the Try node)
        let dst = &assigned[0].dst;
        assert!(dst.contains("CALL"), "ASSIGNED_FROM should point to CALL, got: {}", dst);
    }

    #[test]
    fn test_property_access_reads_from() {
        let fa = parse_and_analyze("struct S { x: i32 } fn main() { let s = S { x: 1 }; let v = s.x; }");
        // PROPERTY_ACCESS "x" should have READS_FROM → REFERENCE "s"
        let reads: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "READS_FROM" && e.src.contains("PROPERTY_ACCESS"))
            .collect();
        assert!(!reads.is_empty(), "PROPERTY_ACCESS should have READS_FROM");
    }

    // -----------------------------------------------------------------------
    // Foreign (FFI) declarations — `extern "C" { ... }` blocks
    // -----------------------------------------------------------------------

    #[test]
    fn test_foreign_fn_emits_function_node() {
        let fa = parse_and_analyze(r#"extern "C" { fn malloc(size: usize) -> *mut u8; }"#);
        assert!(has_node(&fa, "FUNCTION", "malloc"), "foreign fn -> FUNCTION node");
        let f = fa.nodes.iter()
            .find(|n| n.node_type == "FUNCTION" && n.name == "malloc")
            .unwrap();
        assert_eq!(f.metadata.get("foreign"), Some(&serde_json::json!(true)), "tagged foreign=true");
        assert_eq!(f.metadata.get("abi"), Some(&serde_json::json!("C")), "abi recorded");
        // Declared in module scope so it is a resolution target.
        assert!(has_edge(&fa, "CONTAINS", "MODULE", "FUNCTION->malloc"), "CONTAINS from module");
        assert!(has_edge(&fa, "DECLARES", "MODULE", "FUNCTION->malloc"), "DECLARES from module");
    }

    #[test]
    fn test_foreign_fn_params_walked() {
        let fa = parse_and_analyze(
            r#"extern "C" { fn write(fd: i32, buf: *const u8, n: usize) -> isize; }"#
        );
        assert!(has_node(&fa, "PARAMETER", "fd"), "param fd");
        assert!(has_node(&fa, "PARAMETER", "buf"), "param buf");
        assert!(has_node(&fa, "PARAMETER", "n"), "param n");
        let fd = fa.nodes.iter()
            .find(|n| n.node_type == "PARAMETER" && n.name == "fd")
            .unwrap();
        assert_eq!(fd.metadata.get("typeAnnotation"), Some(&serde_json::json!("i32")));
    }

    #[test]
    fn test_foreign_static_emits_variable() {
        let fa = parse_and_analyze(r#"extern "C" { static mut errno: i32; }"#);
        assert!(has_node(&fa, "VARIABLE", "errno"), "foreign static -> VARIABLE node");
        let v = fa.nodes.iter()
            .find(|n| n.node_type == "VARIABLE" && n.name == "errno")
            .unwrap();
        assert_eq!(v.metadata.get("kind"), Some(&serde_json::json!("static")));
        assert_eq!(v.metadata.get("mutable"), Some(&serde_json::json!(true)));
        assert_eq!(v.metadata.get("foreign"), Some(&serde_json::json!(true)));
    }

    #[test]
    fn test_foreign_opaque_type_emits_type_alias() {
        let fa = parse_and_analyze(r#"extern "C" { type Opaque; }"#);
        assert!(has_node(&fa, "TYPE_ALIAS", "Opaque"), "foreign type -> TYPE_ALIAS node");
        let t = fa.nodes.iter()
            .find(|n| n.node_type == "TYPE_ALIAS" && n.name == "Opaque")
            .unwrap();
        assert_eq!(t.metadata.get("foreign"), Some(&serde_json::json!(true)));
    }

    #[test]
    fn test_call_to_foreign_fn_resolves() {
        // A same-file call to a foreign fn must resolve to the foreign FUNCTION
        // declaration via the deferred-CALLS scope-chain walk.
        let fa = parse_and_analyze(
            r#"extern "C" { fn abs(x: i32) -> i32; } fn main() { let _ = abs(-3); }"#
        );
        assert!(has_node(&fa, "FUNCTION", "abs"), "foreign FUNCTION abs");
        assert!(has_node(&fa, "CALL", "abs"), "CALL abs");
        let calls: Vec<_> = fa.edges.iter()
            .filter(|e| e.edge_type == "CALLS" && e.dst.contains("FUNCTION->abs"))
            .collect();
        assert!(!calls.is_empty(), "CALLS edge resolves to foreign fn abs");
    }

    #[test]
    fn test_foreign_variadic_fn_no_panic() {
        // C variadics (`...`) live in sig.variadic, not sig.inputs — must not panic.
        let fa = parse_and_analyze(r#"extern "C" { fn printf(fmt: *const u8, ...) -> i32; }"#);
        assert!(has_node(&fa, "FUNCTION", "printf"), "variadic foreign fn -> FUNCTION");
        assert!(has_node(&fa, "PARAMETER", "fmt"), "fixed param fmt emitted");
    }

    #[test]
    fn test_empty_extern_block_no_panic() {
        let fa = parse_and_analyze(r#"extern "C" {}"#);
        assert_eq!(count_nodes(&fa, "FUNCTION"), 0, "empty extern block emits no fns");
    }

    #[test]
    fn test_bare_extern_block_defaults_abi_c() {
        // `extern { ... }` with no explicit ABI string defaults to "C".
        let fa = parse_and_analyze(r#"extern { fn puts(s: *const u8) -> i32; }"#);
        let f = fa.nodes.iter()
            .find(|n| n.node_type == "FUNCTION" && n.name == "puts")
            .expect("FUNCTION puts");
        assert_eq!(f.metadata.get("abi"), Some(&serde_json::json!("C")));
    // Associated items inside `impl` blocks and `trait` definitions used to be
    // silently dropped (ImplItem::Const/Type were empty no-ops; walk_trait only
    // matched TraitItem::Fn), so `Self::MAX` and associated-type queries returned
    // nothing. They are now modelled like their free counterparts (const ->
    // VARIABLE, type -> TYPE_ALIAS), parented to the enclosing impl/trait via the
    // auto CONTAINS + DECLARES edges, with metadata `associated: true`.
    #[test]
    fn test_impl_associated_const() {
        let fa = parse_and_analyze("struct Foo; impl Foo { const MAX: u32 = 10; }");
        assert!(has_node(&fa, "VARIABLE", "MAX"), "associated const -> VARIABLE");
        let c = fa.nodes.iter()
            .find(|n| n.node_type == "VARIABLE" && n.name == "MAX").unwrap();
        assert_eq!(c.metadata.get("kind"), Some(&serde_json::json!("const")));
        assert_eq!(c.metadata.get("associated"), Some(&serde_json::json!(true)));
        assert!(has_edge(&fa, "CONTAINS", "IMPL_BLOCK", "VARIABLE"), "IMPL_BLOCK CONTAINS const");
        assert!(has_edge(&fa, "DECLARES", "IMPL_BLOCK", "VARIABLE"), "IMPL_BLOCK DECLARES const");
        // The initializer expression is walked (literal 10 emitted).
        assert!(has_node(&fa, "LITERAL", "10"), "const initializer literal walked");
    }

    #[test]
    fn test_impl_associated_type() {
        let fa = parse_and_analyze("struct Foo; impl Foo { type Out = i32; }");
        assert!(has_node(&fa, "TYPE_ALIAS", "Out"), "associated type -> TYPE_ALIAS");
        let t = fa.nodes.iter()
            .find(|n| n.node_type == "TYPE_ALIAS" && n.name == "Out").unwrap();
        assert_eq!(t.metadata.get("associated"), Some(&serde_json::json!(true)));
        assert!(has_edge(&fa, "CONTAINS", "IMPL_BLOCK", "TYPE_ALIAS"), "IMPL_BLOCK CONTAINS type");
    }

    #[test]
    fn test_trait_associated_const() {
        let fa = parse_and_analyze("pub trait Limits { const MAX: u32; const MIN: u32 = 0; }");
        assert!(has_node(&fa, "VARIABLE", "MAX"), "required associated const");
        assert!(has_node(&fa, "VARIABLE", "MIN"), "defaulted associated const");
        assert!(has_edge(&fa, "CONTAINS", "TRAIT", "VARIABLE"), "TRAIT CONTAINS const");
        // The default initializer expression is walked (literal 0 emitted).
        assert!(has_node(&fa, "LITERAL", "0"), "default const initializer walked");
    }

    #[test]
    fn test_trait_associated_type() {
        let fa = parse_and_analyze("pub trait Container { type Item; fn get(&self); }");
        assert!(has_node(&fa, "TYPE_ALIAS", "Item"), "associated type decl -> TYPE_ALIAS");
        assert!(has_edge(&fa, "CONTAINS", "TRAIT", "TYPE_ALIAS"), "TRAIT CONTAINS type");
        // The function signature is still emitted alongside the associated type.
        assert_eq!(count_nodes(&fa, "TYPE_SIGNATURE"), 1);
    // ── Macro invocations ───────────────────────────────────────────────
    // `syn` does not expand macros, so before this fix `Expr::Macro` and
    // `Stmt::Macro` were dropped entirely. That violated KNOWN_LIMITATIONS'
    // contract ("macro invocations appear as CALL nodes") and, worse, lost
    // every call/reference nested inside macro arguments from the graph.

    #[test]
    fn test_macro_invocation_emits_call_node() {
        let fa = parse_and_analyze("fn main() { println!(\"hello\"); }");
        let call = fa.nodes.iter()
            .find(|n| n.node_type == "CALL" && n.name == "println")
            .expect("macro invocation should emit a CALL node");
        assert_eq!(call.metadata.get("macro"), Some(&serde_json::json!(true)),
            "macro CALL node tagged macro=true to distinguish from real fn calls");
        assert_eq!(call.metadata.get("method"), Some(&serde_json::json!(false)),
            "macro CALL is not a method call");
    }

    #[test]
    fn test_nested_call_inside_macro_is_walked() {
        // The real cost of dropping Expr::Macro: calls nested in macro args
        // vanish from the graph. compute() inside println! must be captured.
        let fa = parse_and_analyze(
            "fn main() { println!(\"{}\", compute()); } fn compute() -> i32 { 0 }"
        );
        assert!(has_node(&fa, "CALL", "compute"),
            "call nested inside a macro argument must be walked into the graph");
        // The macro CALL passes the nested call as an argument.
        assert!(has_edge(&fa, "PASSES_ARGUMENT", "CALL", "CALL"),
            "macro should emit PASSES_ARGUMENT to its walked expression args");
    }

    #[test]
    fn test_macro_expr_and_stmt_positions_walk_args() {
        // `vec![...]` as a let initializer is Expr::Macro; `assert_eq!(...)` as a
        // bare statement is Stmt::Macro. Both must emit CALL nodes and walk their
        // comma-separated expression arguments.
        let fa = parse_and_analyze(
            "fn main() {
                let v = vec![first(), second()];
                assert_eq!(left(), right());
            }
            fn first() {} fn second() {} fn left() {} fn right() {}"
        );
        assert!(has_node(&fa, "CALL", "vec"), "vec! emits CALL (Expr::Macro)");
        assert!(has_node(&fa, "CALL", "assert_eq"), "assert_eq! emits CALL (Stmt::Macro)");
        for callee in ["first", "second", "left", "right"] {
            assert!(has_node(&fa, "CALL", callee),
                "nested call {callee} inside a macro must be walked");
        }
    }

    #[test]
    fn test_non_expression_macro_body_no_panic() {
        // A macro whose body is not a comma-separated expression list (here a
        // match-style pattern arm) must not panic and must still emit the macro
        // CALL node — argument walking is strictly best-effort.
        let fa = parse_and_analyze("fn main() { let _ = matches!(x, Some(_)); }");
        assert!(has_node(&fa, "CALL", "matches"),
            "matches! emits a CALL node even though its body isn't an expr list");
    }
}
