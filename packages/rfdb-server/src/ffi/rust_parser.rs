//! Rust source parser using syn crate with NAPI bindings
//! Provides parse_rust_file() function callable from JavaScript

use napi::bindgen_prelude::*;
use napi_derive::napi;
use proc_macro2::Span;
use syn::{
    parse_file, Attribute, Block, Expr, ExprCall, ExprMethodCall, Fields, FnArg, ImplItem, Item,
    ItemFn, ItemImpl, ItemStruct, ItemTrait, Meta, Pat, TraitItem, Visibility,
};
use syn::visit::{self, Visit};
use quote::ToTokens;

// ============ NAPI Output Structures ============

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustCallInfo {
    pub line: u32,
    pub column: u32,
    pub call_type: String,       // "function" | "method" | "macro"
    pub name: Option<String>,    // function name for direct calls
    pub receiver: Option<String>, // receiver for method calls (e.g., "self", "self.engine")
    pub method: Option<String>,  // method name for method calls
    pub args_count: u32,
    pub side_effect: Option<String>, // "fs:read", "fs:write", "net:request", "panic", "io:print", etc.
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustUnsafeBlock {
    pub line: u32,
    pub column: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustFunctionInfo {
    pub name: String,
    pub line: u32,
    pub column: u32,
    pub is_pub: bool,
    pub is_async: bool,
    pub is_unsafe: bool,
    pub is_const: bool,
    pub is_napi: bool,
    pub napi_js_name: Option<String>,
    pub napi_constructor: bool,
    pub napi_getter: Option<String>,
    pub napi_setter: Option<String>,
    pub params: Vec<RustParamInfo>,
    pub return_type: Option<String>,
    pub self_type: Option<String>,
    pub calls: Vec<RustCallInfo>,
    pub unsafe_blocks: Vec<RustUnsafeBlock>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustParamInfo {
    pub name: String,
    pub type_str: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustStructInfo {
    pub name: String,
    pub line: u32,
    pub is_pub: bool,
    pub is_napi: bool,
    pub fields: Vec<RustFieldInfo>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustFieldInfo {
    pub name: Option<String>,
    pub type_str: String,
    pub is_pub: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustImplInfo {
    pub target_type: String,
    pub trait_name: Option<String>,
    pub line: u32,
    pub methods: Vec<RustFunctionInfo>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustTraitInfo {
    pub name: String,
    pub line: u32,
    pub is_pub: bool,
    pub methods: Vec<RustFunctionInfo>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustModInfo {
    pub name: String,
    pub line: u32,
    pub is_pub: bool,
    pub is_inline: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RustUseInfo {
    pub path: String,
    pub line: u32,
    pub is_pub: bool,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct RustParseResult {
    pub functions: Vec<RustFunctionInfo>,
    pub structs: Vec<RustStructInfo>,
    pub impls: Vec<RustImplInfo>,
    pub traits: Vec<RustTraitInfo>,
    pub mods: Vec<RustModInfo>,
    pub uses: Vec<RustUseInfo>,
}

// ============ Main Parse Function ============

#[napi]
pub fn parse_rust_file(content: String) -> napi::Result<RustParseResult> {
    let syntax = parse_file(&content)
        .map_err(|e| napi::Error::from_reason(format!("Parse error: {}", e)))?;

    let mut result = RustParseResult::default();

    for item in syntax.items {
        match item {
            Item::Fn(func) => {
                result.functions.push(parse_item_fn(&func));
            }
            Item::Struct(s) => {
                result.structs.push(parse_item_struct(&s));
            }
            Item::Impl(i) => {
                result.impls.push(parse_item_impl(&i));
            }
            Item::Trait(t) => {
                result.traits.push(parse_item_trait(&t));
            }
            Item::Mod(m) => {
                result.mods.push(RustModInfo {
                    name: m.ident.to_string(),
                    line: span_to_line(m.ident.span()),
                    is_pub: is_pub(&m.vis),
                    is_inline: m.content.is_some(),
                });
            }
            Item::Use(u) => {
                result.uses.push(RustUseInfo {
                    path: format!("{}", quote::quote!(#u)),
                    line: span_to_line(u.use_token.span),
                    is_pub: is_pub(&u.vis),
                });
            }
            _ => {}
        }
    }

    Ok(result)
}

// ============ Parsing Helpers ============

fn parse_item_fn(func: &ItemFn) -> RustFunctionInfo {
    let napi_info = extract_napi_info(&func.attrs);
    let analysis = analyze_block(&func.block);

    RustFunctionInfo {
        name: func.sig.ident.to_string(),
        line: span_to_line(func.sig.ident.span()),
        column: span_to_column(func.sig.ident.span()),
        is_pub: is_pub(&func.vis),
        is_async: func.sig.asyncness.is_some(),
        is_unsafe: func.sig.unsafety.is_some(),
        is_const: func.sig.constness.is_some(),
        is_napi: napi_info.is_napi,
        napi_js_name: napi_info.js_name,
        napi_constructor: napi_info.constructor,
        napi_getter: napi_info.getter,
        napi_setter: napi_info.setter,
        params: parse_fn_params(&func.sig.inputs),
        return_type: parse_return_type(&func.sig.output),
        self_type: None,
        calls: analysis.calls,
        unsafe_blocks: analysis.unsafe_blocks,
    }
}

fn parse_impl_fn(func: &syn::ImplItemFn) -> RustFunctionInfo {
    let napi_info = extract_napi_info(&func.attrs);
    let analysis = analyze_block(&func.block);

    let self_type = func.sig.inputs.first().and_then(|arg| match arg {
        FnArg::Receiver(r) => {
            let mut s = String::new();
            if r.reference.is_some() {
                s.push('&');
                if r.mutability.is_some() {
                    s.push_str("mut ");
                }
            }
            s.push_str("self");
            Some(s)
        }
        _ => None,
    });

    RustFunctionInfo {
        name: func.sig.ident.to_string(),
        line: span_to_line(func.sig.ident.span()),
        column: span_to_column(func.sig.ident.span()),
        is_pub: matches!(&func.vis, Visibility::Public(_)),
        is_async: func.sig.asyncness.is_some(),
        is_unsafe: func.sig.unsafety.is_some(),
        is_const: func.sig.constness.is_some(),
        is_napi: napi_info.is_napi,
        napi_js_name: napi_info.js_name,
        napi_constructor: napi_info.constructor,
        napi_getter: napi_info.getter,
        napi_setter: napi_info.setter,
        params: parse_fn_params(&func.sig.inputs),
        return_type: parse_return_type(&func.sig.output),
        self_type,
        calls: analysis.calls,
        unsafe_blocks: analysis.unsafe_blocks,
    }
}

fn parse_item_struct(s: &ItemStruct) -> RustStructInfo {
    let napi_info = extract_napi_info(&s.attrs);

    RustStructInfo {
        name: s.ident.to_string(),
        line: span_to_line(s.ident.span()),
        is_pub: is_pub(&s.vis),
        is_napi: napi_info.is_napi,
        fields: parse_fields(&s.fields),
    }
}

fn parse_item_impl(i: &ItemImpl) -> RustImplInfo {
    let self_ty = &i.self_ty;
    let target_type = format!("{}", quote::quote!(#self_ty));
    let trait_name = i.trait_.as_ref().map(|(_, path, _)| format!("{}", quote::quote!(#path)));

    let methods: Vec<RustFunctionInfo> = i
        .items
        .iter()
        .filter_map(|item| match item {
            ImplItem::Fn(f) => Some(parse_impl_fn(f)),
            _ => None,
        })
        .collect();

    RustImplInfo {
        target_type,
        trait_name,
        line: span_to_line(i.impl_token.span),
        methods,
    }
}

fn parse_item_trait(t: &ItemTrait) -> RustTraitInfo {
    let methods: Vec<RustFunctionInfo> = t
        .items
        .iter()
        .filter_map(|item| match item {
            TraitItem::Fn(f) => {
                let napi_info = extract_napi_info(&f.attrs);
                let self_type = f.sig.inputs.first().and_then(|arg| match arg {
                    FnArg::Receiver(r) => {
                        let mut s = String::new();
                        if r.reference.is_some() {
                            s.push('&');
                            if r.mutability.is_some() {
                                s.push_str("mut ");
                            }
                        }
                        s.push_str("self");
                        Some(s)
                    }
                    _ => None,
                });

                // Trait methods may have default implementations
                let analysis = f.default.as_ref()
                    .map(|block| analyze_block(block));

                Some(RustFunctionInfo {
                    name: f.sig.ident.to_string(),
                    line: span_to_line(f.sig.ident.span()),
                    column: span_to_column(f.sig.ident.span()),
                    is_pub: true,
                    is_async: f.sig.asyncness.is_some(),
                    is_unsafe: f.sig.unsafety.is_some(),
                    is_const: f.sig.constness.is_some(),
                    is_napi: napi_info.is_napi,
                    napi_js_name: napi_info.js_name,
                    napi_constructor: napi_info.constructor,
                    napi_getter: napi_info.getter,
                    napi_setter: napi_info.setter,
                    params: parse_fn_params(&f.sig.inputs),
                    return_type: parse_return_type(&f.sig.output),
                    self_type,
                    calls: analysis.as_ref().map(|a| a.calls.clone()).unwrap_or_default(),
                    unsafe_blocks: analysis.map(|a| a.unsafe_blocks).unwrap_or_default(),
                })
            }
            _ => None,
        })
        .collect();

    RustTraitInfo {
        name: t.ident.to_string(),
        line: span_to_line(t.ident.span()),
        is_pub: is_pub(&t.vis),
        methods,
    }
}

fn parse_fields(fields: &Fields) -> Vec<RustFieldInfo> {
    match fields {
        Fields::Named(named) => named
            .named
            .iter()
            .map(|f| {
                let ty = &f.ty;
                RustFieldInfo {
                    name: f.ident.as_ref().map(|i| i.to_string()),
                    type_str: format!("{}", quote::quote!(#ty)),
                    is_pub: is_pub(&f.vis),
                }
            })
            .collect(),
        Fields::Unnamed(unnamed) => unnamed
            .unnamed
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let ty = &f.ty;
                RustFieldInfo {
                    name: Some(format!("{}", i)),
                    type_str: format!("{}", quote::quote!(#ty)),
                    is_pub: is_pub(&f.vis),
                }
            })
            .collect(),
        Fields::Unit => Vec::new(),
    }
}

fn parse_fn_params(
    inputs: &syn::punctuated::Punctuated<FnArg, syn::token::Comma>,
) -> Vec<RustParamInfo> {
    inputs
        .iter()
        .filter_map(|arg| match arg {
            FnArg::Typed(pat) => {
                let name = match pat.pat.as_ref() {
                    Pat::Ident(ident) => ident.ident.to_string(),
                    _ => "_".to_string(),
                };
                let ty = &pat.ty;
                Some(RustParamInfo {
                    name,
                    type_str: format!("{}", quote::quote!(#ty)),
                })
            }
            FnArg::Receiver(_) => None,
        })
        .collect()
}

fn parse_return_type(output: &syn::ReturnType) -> Option<String> {
    match output {
        syn::ReturnType::Default => None,
        syn::ReturnType::Type(_, ty) => Some(format!("{}", quote::quote!(#ty))),
    }
}

// ============ NAPI Attribute Extraction ============

struct NapiInfo {
    is_napi: bool,
    js_name: Option<String>,
    constructor: bool,
    getter: Option<String>,
    setter: Option<String>,
}

impl Default for NapiInfo {
    fn default() -> Self {
        Self {
            is_napi: false,
            js_name: None,
            constructor: false,
            getter: None,
            setter: None,
        }
    }
}

fn extract_napi_info(attrs: &[Attribute]) -> NapiInfo {
    let mut info = NapiInfo::default();

    for attr in attrs {
        if attr.path().is_ident("napi") {
            info.is_napi = true;

            if let Meta::List(list) = &attr.meta {
                let tokens = list.tokens.to_string();

                // js_name = "..."
                if let Ok(re) = regex_lite::Regex::new(r#"js_name\s*=\s*"([^"]+)""#) {
                    if let Some(cap) = re.captures(&tokens) {
                        info.js_name = Some(cap.get(1).unwrap().as_str().to_string());
                    }
                }

                // constructor
                if tokens.contains("constructor") {
                    info.constructor = true;
                }

                // getter, getter = "name"
                if tokens.contains("getter") {
                    if let Ok(re) = regex_lite::Regex::new(r#"getter\s*=\s*"([^"]+)""#) {
                        if let Some(cap) = re.captures(&tokens) {
                            info.getter = Some(cap.get(1).unwrap().as_str().to_string());
                        } else {
                            info.getter = Some(String::new());
                        }
                    } else {
                        info.getter = Some(String::new());
                    }
                }

                // setter, setter = "name"
                if tokens.contains("setter") {
                    if let Ok(re) = regex_lite::Regex::new(r#"setter\s*=\s*"([^"]+)""#) {
                        if let Some(cap) = re.captures(&tokens) {
                            info.setter = Some(cap.get(1).unwrap().as_str().to_string());
                        } else {
                            info.setter = Some(String::new());
                        }
                    } else {
                        info.setter = Some(String::new());
                    }
                }
            }
        }
    }

    info
}

// ============ Call Extraction Visitor ============

/// Visitor that extracts function/method calls and unsafe blocks from a block
struct CallVisitor {
    calls: Vec<RustCallInfo>,
    unsafe_blocks: Vec<RustUnsafeBlock>,
}

impl CallVisitor {
    fn new() -> Self {
        Self {
            calls: Vec::new(),
            unsafe_blocks: Vec::new(),
        }
    }

    /// Extract receiver expression as string (e.g., "self", "self.engine", "foo")
    fn expr_to_string(expr: &Expr) -> String {
        match expr {
            Expr::Path(p) => {
                p.path.segments.iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::")
            }
            Expr::Field(f) => {
                format!("{}.{}", Self::expr_to_string(&f.base), f.member.to_token_stream())
            }
            Expr::Reference(r) => {
                Self::expr_to_string(&r.expr)
            }
            Expr::Paren(p) => {
                Self::expr_to_string(&p.expr)
            }
            Expr::Call(c) => {
                // For chained calls like foo().bar(), just mark as "<call>"
                format!("{}()", Self::expr_to_string(&c.func))
            }
            Expr::MethodCall(m) => {
                format!("{}.{}()", Self::expr_to_string(&m.receiver), m.method)
            }
            _ => "<expr>".to_string(),
        }
    }
}

impl<'ast> Visit<'ast> for CallVisitor {
    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        // Direct function call: func(args) or path::func(args)
        let name = match &*node.func {
            Expr::Path(p) => {
                Some(p.path.segments.iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::"))
            }
            _ => None,
        };

        let side_effect = detect_side_effect("function", name.as_deref(), None);

        self.calls.push(RustCallInfo {
            line: span_to_line(node.paren_token.span.open()),
            column: span_to_column(node.paren_token.span.open()),
            call_type: "function".to_string(),
            name,
            receiver: None,
            method: None,
            args_count: node.args.len() as u32,
            side_effect,
        });

        // Continue visiting nested expressions
        visit::visit_expr_call(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        // Method call: receiver.method(args)
        let receiver = Self::expr_to_string(&node.receiver);
        let method = node.method.to_string();

        let side_effect = detect_side_effect("method", None, Some(&method));

        self.calls.push(RustCallInfo {
            line: span_to_line(node.method.span()),
            column: span_to_column(node.method.span()),
            call_type: "method".to_string(),
            name: None,
            receiver: Some(receiver),
            method: Some(method),
            args_count: node.args.len() as u32,
            side_effect,
        });

        // Continue visiting nested expressions
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_macro(&mut self, node: &'ast syn::ExprMacro) {
        // Macro call in expression position: let x = macro!(args)
        self.add_macro_call(&node.mac);
        visit::visit_expr_macro(self, node);
    }

    fn visit_stmt(&mut self, node: &'ast syn::Stmt) {
        // Check for statement-level macros like println!("hello");
        if let syn::Stmt::Macro(stmt_macro) = node {
            self.add_macro_call(&stmt_macro.mac);
        }
        visit::visit_stmt(self, node);
    }

    fn visit_expr_unsafe(&mut self, node: &'ast syn::ExprUnsafe) {
        // Unsafe block: unsafe { ... }
        self.unsafe_blocks.push(RustUnsafeBlock {
            line: span_to_line(node.unsafe_token.span),
            column: span_to_column(node.unsafe_token.span),
        });
        // Continue visiting inside the unsafe block
        visit::visit_expr_unsafe(self, node);
    }
}

impl CallVisitor {
    fn add_macro_call(&mut self, mac: &syn::Macro) {
        let name = mac.path.segments.iter()
            .map(|s| s.ident.to_string())
            .collect::<Vec<_>>()
            .join("::");

        let macro_name = format!("{}!", name);
        let side_effect = detect_side_effect("macro", Some(&macro_name), None);

        self.calls.push(RustCallInfo {
            line: span_to_line(mac.path.segments.first()
                .map(|s| s.ident.span())
                .unwrap_or_else(Span::call_site)),
            column: 0,
            call_type: "macro".to_string(),
            name: Some(macro_name),
            receiver: None,
            method: None,
            args_count: 0,
            side_effect,
        });
    }
}

/// Result of extracting semantic information from a function body
struct BlockAnalysis {
    calls: Vec<RustCallInfo>,
    unsafe_blocks: Vec<RustUnsafeBlock>,
}

/// Extract calls and unsafe blocks from a function body block
fn analyze_block(block: &Block) -> BlockAnalysis {
    let mut visitor = CallVisitor::new();
    visitor.visit_block(block);
    BlockAnalysis {
        calls: visitor.calls,
        unsafe_blocks: visitor.unsafe_blocks,
    }
}

// ============ Utility Functions ============

fn is_pub(vis: &Visibility) -> bool {
    matches!(vis, Visibility::Public(_))
}

fn span_to_line(span: Span) -> u32 {
    span.start().line as u32
}

fn span_to_column(span: Span) -> u32 {
    span.start().column as u32
}

// ============ Side Effect Detection ============

/// Detect side effect category from a function/method call
/// Returns Some("category:operation") or None
fn detect_side_effect(
    call_type: &str,
    name: Option<&str>,
    method: Option<&str>,
) -> Option<String> {
    // Check function calls by path
    if let Some(name) = name {
        // Filesystem operations
        if name.starts_with("std::fs::") {
            let op = name.strip_prefix("std::fs::").unwrap();
            return match op {
                "read" | "read_to_string" | "read_dir" | "metadata" | "canonicalize" => {
                    Some("fs:read".to_string())
                }
                "write" | "create" | "create_dir" | "create_dir_all" | "remove_file"
                | "remove_dir" | "remove_dir_all" | "rename" | "copy" | "hard_link"
                | "symlink" | "set_permissions" => Some("fs:write".to_string()),
                _ => Some("fs:other".to_string()),
            };
        }

        // Network operations
        if name.starts_with("std::net::") || name.starts_with("reqwest::") || name.starts_with("hyper::") {
            return Some("net:request".to_string());
        }
        if name.starts_with("tokio::net::") {
            return Some("net:request".to_string());
        }

        // IO operations
        if name.starts_with("std::io::") {
            return Some("io:stream".to_string());
        }

        // Environment
        if name.starts_with("std::env::") {
            let op = name.strip_prefix("std::env::").unwrap();
            return match op {
                "var" | "var_os" | "vars" | "vars_os" | "current_dir" | "current_exe"
                | "home_dir" | "temp_dir" => Some("env:read".to_string()),
                "set_var" | "remove_var" | "set_current_dir" => Some("env:write".to_string()),
                _ => Some("env:other".to_string()),
            };
        }

        // Process operations
        if name.starts_with("std::process::") {
            return Some("process:spawn".to_string());
        }

        // Thread operations
        if name.starts_with("std::thread::") {
            return Some("thread:spawn".to_string());
        }

        // Panic-inducing macros
        if call_type == "macro" {
            match name {
                "panic!" | "todo!" | "unimplemented!" | "unreachable!" => {
                    return Some("panic".to_string());
                }
                "println!" | "print!" | "eprintln!" | "eprint!" => {
                    return Some("io:print".to_string());
                }
                "dbg!" => {
                    return Some("io:debug".to_string());
                }
                _ => {}
            }
        }
    }

    // Check method calls
    if let Some(method) = method {
        match method {
            // Panic-inducing methods
            "unwrap" | "expect" => return Some("panic".to_string()),

            // IO methods on common types
            "read" | "read_exact" | "read_to_end" | "read_to_string" | "read_line" => {
                return Some("io:read".to_string());
            }
            "write" | "write_all" | "write_fmt" | "flush" => {
                return Some("io:write".to_string());
            }

            // Network methods
            "send" | "recv" | "connect" | "bind" | "listen" | "accept" => {
                return Some("net:socket".to_string());
            }
            "get" | "post" | "put" | "delete" | "patch" | "head" => {
                return Some("net:http".to_string());
            }

            // Synchronization (potential blocking)
            "lock" | "read" | "write" if method == "lock" => {
                return Some("sync:lock".to_string());
            }
            "wait" | "notify_one" | "notify_all" => {
                return Some("sync:condvar".to_string());
            }

            _ => {}
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_function() {
        let code = r#"
            pub fn hello_world() {
                println!("Hello");
            }
        "#;
        let result = parse_rust_file(code.to_string()).unwrap();
        assert_eq!(result.functions.len(), 1);
        assert_eq!(result.functions[0].name, "hello_world");
        assert!(result.functions[0].is_pub);
    }

    #[test]
    fn test_parse_napi_function() {
        let code = r#"
            #[napi]
            pub fn add_nodes(&self, nodes: Vec<Node>) -> Result<()> {
                Ok(())
            }
        "#;
        let result = parse_rust_file(code.to_string()).unwrap();
        assert_eq!(result.functions.len(), 1);
        assert!(result.functions[0].is_napi);
    }

    #[test]
    fn test_parse_impl_block() {
        let code = r#"
            impl GraphEngine {
                #[napi]
                pub fn new() -> Self {
                    GraphEngine {}
                }

                #[napi]
                pub fn add_node(&mut self, node: Node) {
                }
            }
        "#;
        let result = parse_rust_file(code.to_string()).unwrap();
        assert_eq!(result.impls.len(), 1);
        assert_eq!(result.impls[0].target_type, "GraphEngine");
        assert_eq!(result.impls[0].methods.len(), 2);
        assert!(result.impls[0].methods[0].is_napi);
        assert!(result.impls[0].methods[1].is_napi);
    }

    #[test]
    fn test_parse_struct() {
        let code = r#"
            #[napi]
            pub struct GraphEngine {
                engine: Arc<RwLock<Engine>>,
            }
        "#;
        let result = parse_rust_file(code.to_string()).unwrap();
        assert_eq!(result.structs.len(), 1);
        assert_eq!(result.structs[0].name, "GraphEngine");
        assert!(result.structs[0].is_napi);
        assert_eq!(result.structs[0].fields.len(), 1);
    }
}
