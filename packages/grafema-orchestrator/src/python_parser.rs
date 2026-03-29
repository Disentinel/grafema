//! Python parser: .py/.pyi files -> JSON AST using `rustpython-parser`.
//!
//! Parses Python source files into a JSON representation of the AST suitable for
//! Grafema's analysis pipeline. Each AST node carries a `type` discriminator,
//! a `span` with line/col locations, and type-specific fields.

use anyhow::{Context, Result};
use rustpython_parser::ast::{self, Ranged};
use rustpython_parser::text_size::{TextRange, TextSize};
use rustpython_parser::{parse, Mode};
use serde_json::{json, Value};
use std::path::Path;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse a Python source file at `path` and return a JSON string of the AST.
pub fn parse_python_file(path: &Path) -> Result<String> {
    let source = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read {}", path.display()))?;
    let filename = path.display().to_string();
    parse_python_source(&source, &filename)
}

/// Parse Python source text directly (useful for tests).
pub fn parse_python_source(source: &str, filename: &str) -> Result<String> {
    let module = parse(source, Mode::Module, filename)
        .map_err(|e| anyhow::anyhow!("Parse error in {}: {}", filename, e))?;
    let line_index = LineIndex::new(source);
    let json = serialize_mod(&module, &line_index);
    serde_json::to_string(&json).context("Failed to serialize AST to JSON")
}

// ---------------------------------------------------------------------------
// Line index: byte offset → line/col
// ---------------------------------------------------------------------------

struct LineIndex {
    /// Byte offsets where each line starts. lines[0] = 0.
    line_starts: Vec<u32>,
}

impl LineIndex {
    fn new(source: &str) -> Self {
        let mut line_starts = vec![0u32];
        for (i, ch) in source.char_indices() {
            if ch == '\n' {
                line_starts.push((i + 1) as u32);
            }
        }
        LineIndex { line_starts }
    }

    /// Convert a byte offset into a (line, col) pair.  Lines are 1-based, columns 0-based.
    fn offset_to_line_col(&self, offset: TextSize) -> (u32, u32) {
        let offset = u32::from(offset);
        // Binary search for the line containing this offset.
        let line = match self.line_starts.binary_search(&offset) {
            Ok(idx) => idx,
            Err(idx) => idx - 1,
        };
        let col = offset - self.line_starts[line];
        ((line as u32) + 1, col)
    }
}

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------

fn serialize_span(range: TextRange, idx: &LineIndex) -> Value {
    let (sl, sc) = idx.offset_to_line_col(range.start());
    let (el, ec) = idx.offset_to_line_col(range.end());
    json!({
        "start": { "line": sl, "col": sc },
        "end":   { "line": el, "col": ec }
    })
}

// ---------------------------------------------------------------------------
// Module (top-level)
// ---------------------------------------------------------------------------

fn serialize_mod(module: &ast::Mod, idx: &LineIndex) -> Value {
    match module {
        ast::Mod::Module(m) => {
            let body: Vec<Value> = m.body.iter().map(|s| serialize_stmt(s, idx)).collect();
            json!({
                "type": "Module",
                "body": body,
                "span": serialize_span(m.range(), idx)
            })
        }
        ast::Mod::Interactive(m) => {
            let body: Vec<Value> = m.body.iter().map(|s| serialize_stmt(s, idx)).collect();
            json!({
                "type": "Interactive",
                "body": body,
                "span": serialize_span(m.range(), idx)
            })
        }
        ast::Mod::Expression(m) => {
            json!({
                "type": "Expression",
                "body": serialize_expr(&m.body, idx),
                "span": serialize_span(m.range(), idx)
            })
        }
        ast::Mod::FunctionType(m) => {
            let argtypes: Vec<Value> =
                m.argtypes.iter().map(|e| serialize_expr(e, idx)).collect();
            json!({
                "type": "FunctionType",
                "argtypes": argtypes,
                "returns": serialize_expr(&m.returns, idx),
                "span": serialize_span(m.range(), idx)
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

fn serialize_stmt(stmt: &ast::Stmt, idx: &LineIndex) -> Value {
    match stmt {
        ast::Stmt::FunctionDef(f) => {
            let decorators: Vec<Value> =
                f.decorator_list.iter().map(|e| serialize_expr(e, idx)).collect();
            let type_params: Vec<Value> =
                f.type_params.iter().map(|tp| serialize_type_param(tp, idx)).collect();
            json!({
                "type": "FunctionDef",
                "name": f.name.as_str(),
                "args": serialize_arguments(&f.args, idx),
                "body": serialize_body(&f.body, idx),
                "decorator_list": decorators,
                "returns": f.returns.as_ref().map(|e| serialize_expr(e, idx)),
                "type_comment": f.type_comment,
                "type_params": type_params,
                "span": serialize_span(f.range(), idx)
            })
        }
        ast::Stmt::AsyncFunctionDef(f) => {
            let decorators: Vec<Value> =
                f.decorator_list.iter().map(|e| serialize_expr(e, idx)).collect();
            let type_params: Vec<Value> =
                f.type_params.iter().map(|tp| serialize_type_param(tp, idx)).collect();
            json!({
                "type": "AsyncFunctionDef",
                "name": f.name.as_str(),
                "args": serialize_arguments(&f.args, idx),
                "body": serialize_body(&f.body, idx),
                "decorator_list": decorators,
                "returns": f.returns.as_ref().map(|e| serialize_expr(e, idx)),
                "type_comment": f.type_comment,
                "type_params": type_params,
                "span": serialize_span(f.range(), idx)
            })
        }
        ast::Stmt::ClassDef(c) => {
            let bases: Vec<Value> = c.bases.iter().map(|e| serialize_expr(e, idx)).collect();
            let keywords: Vec<Value> =
                c.keywords.iter().map(|kw| serialize_keyword(kw, idx)).collect();
            let decorators: Vec<Value> =
                c.decorator_list.iter().map(|e| serialize_expr(e, idx)).collect();
            let type_params: Vec<Value> =
                c.type_params.iter().map(|tp| serialize_type_param(tp, idx)).collect();
            json!({
                "type": "ClassDef",
                "name": c.name.as_str(),
                "bases": bases,
                "keywords": keywords,
                "body": serialize_body(&c.body, idx),
                "decorator_list": decorators,
                "type_params": type_params,
                "span": serialize_span(c.range(), idx)
            })
        }
        ast::Stmt::Return(r) => {
            json!({
                "type": "Return",
                "value": r.value.as_ref().map(|e| serialize_expr(e, idx)),
                "span": serialize_span(r.range(), idx)
            })
        }
        ast::Stmt::Delete(d) => {
            let targets: Vec<Value> =
                d.targets.iter().map(|e| serialize_expr(e, idx)).collect();
            json!({
                "type": "Delete",
                "targets": targets,
                "span": serialize_span(d.range(), idx)
            })
        }
        ast::Stmt::Assign(a) => {
            let targets: Vec<Value> =
                a.targets.iter().map(|e| serialize_expr(e, idx)).collect();
            json!({
                "type": "Assign",
                "targets": targets,
                "value": serialize_expr(&a.value, idx),
                "type_comment": a.type_comment,
                "span": serialize_span(a.range(), idx)
            })
        }
        ast::Stmt::TypeAlias(ta) => {
            let type_params: Vec<Value> =
                ta.type_params.iter().map(|tp| serialize_type_param(tp, idx)).collect();
            json!({
                "type": "TypeAlias",
                "name": serialize_expr(&ta.name, idx),
                "type_params": type_params,
                "value": serialize_expr(&ta.value, idx),
                "span": serialize_span(ta.range(), idx)
            })
        }
        ast::Stmt::AugAssign(a) => {
            json!({
                "type": "AugAssign",
                "target": serialize_expr(&a.target, idx),
                "op": serialize_operator(&a.op),
                "value": serialize_expr(&a.value, idx),
                "span": serialize_span(a.range(), idx)
            })
        }
        ast::Stmt::AnnAssign(a) => {
            json!({
                "type": "AnnAssign",
                "target": serialize_expr(&a.target, idx),
                "annotation": serialize_expr(&a.annotation, idx),
                "value": a.value.as_ref().map(|e| serialize_expr(e, idx)),
                "simple": a.simple,
                "span": serialize_span(a.range(), idx)
            })
        }
        ast::Stmt::For(f) => {
            json!({
                "type": "For",
                "target": serialize_expr(&f.target, idx),
                "iter": serialize_expr(&f.iter, idx),
                "body": serialize_body(&f.body, idx),
                "orelse": serialize_body(&f.orelse, idx),
                "type_comment": f.type_comment,
                "span": serialize_span(f.range(), idx)
            })
        }
        ast::Stmt::AsyncFor(f) => {
            json!({
                "type": "AsyncFor",
                "target": serialize_expr(&f.target, idx),
                "iter": serialize_expr(&f.iter, idx),
                "body": serialize_body(&f.body, idx),
                "orelse": serialize_body(&f.orelse, idx),
                "type_comment": f.type_comment,
                "span": serialize_span(f.range(), idx)
            })
        }
        ast::Stmt::While(w) => {
            json!({
                "type": "While",
                "test": serialize_expr(&w.test, idx),
                "body": serialize_body(&w.body, idx),
                "orelse": serialize_body(&w.orelse, idx),
                "span": serialize_span(w.range(), idx)
            })
        }
        ast::Stmt::If(i) => {
            json!({
                "type": "If",
                "test": serialize_expr(&i.test, idx),
                "body": serialize_body(&i.body, idx),
                "orelse": serialize_body(&i.orelse, idx),
                "span": serialize_span(i.range(), idx)
            })
        }
        ast::Stmt::With(w) => {
            let items: Vec<Value> =
                w.items.iter().map(|wi| serialize_with_item(wi, idx)).collect();
            json!({
                "type": "With",
                "items": items,
                "body": serialize_body(&w.body, idx),
                "type_comment": w.type_comment,
                "span": serialize_span(w.range(), idx)
            })
        }
        ast::Stmt::AsyncWith(w) => {
            let items: Vec<Value> =
                w.items.iter().map(|wi| serialize_with_item(wi, idx)).collect();
            json!({
                "type": "AsyncWith",
                "items": items,
                "body": serialize_body(&w.body, idx),
                "type_comment": w.type_comment,
                "span": serialize_span(w.range(), idx)
            })
        }
        ast::Stmt::Match(m) => {
            let cases: Vec<Value> =
                m.cases.iter().map(|c| serialize_match_case(c, idx)).collect();
            json!({
                "type": "Match",
                "subject": serialize_expr(&m.subject, idx),
                "cases": cases,
                "span": serialize_span(m.range(), idx)
            })
        }
        ast::Stmt::Raise(r) => {
            json!({
                "type": "Raise",
                "exc": r.exc.as_ref().map(|e| serialize_expr(e, idx)),
                "cause": r.cause.as_ref().map(|e| serialize_expr(e, idx)),
                "span": serialize_span(r.range(), idx)
            })
        }
        ast::Stmt::Try(t) => {
            let handlers: Vec<Value> =
                t.handlers.iter().map(|h| serialize_except_handler(h, idx)).collect();
            json!({
                "type": "Try",
                "body": serialize_body(&t.body, idx),
                "handlers": handlers,
                "orelse": serialize_body(&t.orelse, idx),
                "finalbody": serialize_body(&t.finalbody, idx),
                "span": serialize_span(t.range(), idx)
            })
        }
        ast::Stmt::TryStar(t) => {
            let handlers: Vec<Value> =
                t.handlers.iter().map(|h| serialize_except_handler(h, idx)).collect();
            json!({
                "type": "TryStar",
                "body": serialize_body(&t.body, idx),
                "handlers": handlers,
                "orelse": serialize_body(&t.orelse, idx),
                "finalbody": serialize_body(&t.finalbody, idx),
                "span": serialize_span(t.range(), idx)
            })
        }
        ast::Stmt::Assert(a) => {
            json!({
                "type": "Assert",
                "test": serialize_expr(&a.test, idx),
                "msg": a.msg.as_ref().map(|e| serialize_expr(e, idx)),
                "span": serialize_span(a.range(), idx)
            })
        }
        ast::Stmt::Import(i) => {
            let names: Vec<Value> =
                i.names.iter().map(|a| serialize_alias(a, idx)).collect();
            json!({
                "type": "Import",
                "names": names,
                "span": serialize_span(i.range(), idx)
            })
        }
        ast::Stmt::ImportFrom(i) => {
            let names: Vec<Value> =
                i.names.iter().map(|a| serialize_alias(a, idx)).collect();
            json!({
                "type": "ImportFrom",
                "module": i.module.as_ref().map(|id| id.as_str()),
                "names": names,
                "level": i.level.map(|l| l.to_u32()),
                "span": serialize_span(i.range(), idx)
            })
        }
        ast::Stmt::Global(g) => {
            let names: Vec<Value> =
                g.names.iter().map(|id| json!(id.as_str())).collect();
            json!({
                "type": "Global",
                "names": names,
                "span": serialize_span(g.range(), idx)
            })
        }
        ast::Stmt::Nonlocal(n) => {
            let names: Vec<Value> =
                n.names.iter().map(|id| json!(id.as_str())).collect();
            json!({
                "type": "Nonlocal",
                "names": names,
                "span": serialize_span(n.range(), idx)
            })
        }
        ast::Stmt::Expr(e) => {
            json!({
                "type": "ExprStmt",
                "value": serialize_expr(&e.value, idx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Stmt::Pass(p) => {
            json!({
                "type": "Pass",
                "span": serialize_span(p.range(), idx)
            })
        }
        ast::Stmt::Break(b) => {
            json!({
                "type": "Break",
                "span": serialize_span(b.range(), idx)
            })
        }
        ast::Stmt::Continue(c) => {
            json!({
                "type": "Continue",
                "span": serialize_span(c.range(), idx)
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

fn serialize_expr(expr: &ast::Expr, idx: &LineIndex) -> Value {
    match expr {
        ast::Expr::BoolOp(e) => {
            let values: Vec<Value> =
                e.values.iter().map(|v| serialize_expr(v, idx)).collect();
            json!({
                "type": "BoolOp",
                "op": serialize_boolop(&e.op),
                "values": values,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::NamedExpr(e) => {
            json!({
                "type": "NamedExpr",
                "target": serialize_expr(&e.target, idx),
                "value": serialize_expr(&e.value, idx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::BinOp(e) => {
            json!({
                "type": "BinOp",
                "left": serialize_expr(&e.left, idx),
                "op": serialize_operator(&e.op),
                "right": serialize_expr(&e.right, idx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::UnaryOp(e) => {
            json!({
                "type": "UnaryOp",
                "op": serialize_unaryop(&e.op),
                "operand": serialize_expr(&e.operand, idx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Lambda(e) => {
            json!({
                "type": "Lambda",
                "args": serialize_arguments(&e.args, idx),
                "body": serialize_expr(&e.body, idx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::IfExp(e) => {
            json!({
                "type": "IfExp",
                "test": serialize_expr(&e.test, idx),
                "body": serialize_expr(&e.body, idx),
                "orelse": serialize_expr(&e.orelse, idx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Dict(e) => {
            let keys: Vec<Value> = e
                .keys
                .iter()
                .map(|k| match k {
                    Some(expr) => serialize_expr(expr, idx),
                    None => Value::Null,
                })
                .collect();
            let values: Vec<Value> =
                e.values.iter().map(|v| serialize_expr(v, idx)).collect();
            json!({
                "type": "Dict",
                "keys": keys,
                "values": values,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Set(e) => {
            let elts: Vec<Value> =
                e.elts.iter().map(|v| serialize_expr(v, idx)).collect();
            json!({
                "type": "Set",
                "elts": elts,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::ListComp(e) => {
            let generators: Vec<Value> =
                e.generators.iter().map(|g| serialize_comprehension(g, idx)).collect();
            json!({
                "type": "ListComp",
                "elt": serialize_expr(&e.elt, idx),
                "generators": generators,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::SetComp(e) => {
            let generators: Vec<Value> =
                e.generators.iter().map(|g| serialize_comprehension(g, idx)).collect();
            json!({
                "type": "SetComp",
                "elt": serialize_expr(&e.elt, idx),
                "generators": generators,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::DictComp(e) => {
            let generators: Vec<Value> =
                e.generators.iter().map(|g| serialize_comprehension(g, idx)).collect();
            json!({
                "type": "DictComp",
                "key": serialize_expr(&e.key, idx),
                "value": serialize_expr(&e.value, idx),
                "generators": generators,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::GeneratorExp(e) => {
            let generators: Vec<Value> =
                e.generators.iter().map(|g| serialize_comprehension(g, idx)).collect();
            json!({
                "type": "GeneratorExp",
                "elt": serialize_expr(&e.elt, idx),
                "generators": generators,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Await(e) => {
            json!({
                "type": "Await",
                "value": serialize_expr(&e.value, idx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Yield(e) => {
            json!({
                "type": "Yield",
                "value": e.value.as_ref().map(|v| serialize_expr(v, idx)),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::YieldFrom(e) => {
            json!({
                "type": "YieldFrom",
                "value": serialize_expr(&e.value, idx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Compare(e) => {
            let ops: Vec<Value> = e.ops.iter().map(serialize_cmpop).collect();
            let comparators: Vec<Value> =
                e.comparators.iter().map(|c| serialize_expr(c, idx)).collect();
            json!({
                "type": "Compare",
                "left": serialize_expr(&e.left, idx),
                "ops": ops,
                "comparators": comparators,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Call(e) => {
            let args: Vec<Value> =
                e.args.iter().map(|a| serialize_expr(a, idx)).collect();
            let keywords: Vec<Value> =
                e.keywords.iter().map(|kw| serialize_keyword(kw, idx)).collect();
            json!({
                "type": "Call",
                "func": serialize_expr(&e.func, idx),
                "args": args,
                "keywords": keywords,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::FormattedValue(e) => {
            json!({
                "type": "FormattedValue",
                "value": serialize_expr(&e.value, idx),
                "conversion": serialize_conversion_flag(&e.conversion),
                "format_spec": e.format_spec.as_ref().map(|fs| serialize_expr(fs, idx)),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::JoinedStr(e) => {
            let values: Vec<Value> =
                e.values.iter().map(|v| serialize_expr(v, idx)).collect();
            json!({
                "type": "JoinedStr",
                "values": values,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Constant(e) => {
            json!({
                "type": "Constant",
                "value": serialize_constant(&e.value),
                "kind": e.kind,
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Attribute(e) => {
            json!({
                "type": "Attribute",
                "value": serialize_expr(&e.value, idx),
                "attr": e.attr.as_str(),
                "ctx": serialize_expr_context(&e.ctx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Subscript(e) => {
            json!({
                "type": "Subscript",
                "value": serialize_expr(&e.value, idx),
                "slice": serialize_expr(&e.slice, idx),
                "ctx": serialize_expr_context(&e.ctx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Starred(e) => {
            json!({
                "type": "Starred",
                "value": serialize_expr(&e.value, idx),
                "ctx": serialize_expr_context(&e.ctx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Name(e) => {
            json!({
                "type": "Name",
                "id": e.id.as_str(),
                "ctx": serialize_expr_context(&e.ctx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::List(e) => {
            let elts: Vec<Value> =
                e.elts.iter().map(|v| serialize_expr(v, idx)).collect();
            json!({
                "type": "List",
                "elts": elts,
                "ctx": serialize_expr_context(&e.ctx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Tuple(e) => {
            let elts: Vec<Value> =
                e.elts.iter().map(|v| serialize_expr(v, idx)).collect();
            json!({
                "type": "Tuple",
                "elts": elts,
                "ctx": serialize_expr_context(&e.ctx),
                "span": serialize_span(e.range(), idx)
            })
        }
        ast::Expr::Slice(e) => {
            json!({
                "type": "Slice",
                "lower": e.lower.as_ref().map(|v| serialize_expr(v, idx)),
                "upper": e.upper.as_ref().map(|v| serialize_expr(v, idx)),
                "step": e.step.as_ref().map(|v| serialize_expr(v, idx)),
                "span": serialize_span(e.range(), idx)
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

fn serialize_body(stmts: &[ast::Stmt], idx: &LineIndex) -> Value {
    let items: Vec<Value> = stmts.iter().map(|s| serialize_stmt(s, idx)).collect();
    Value::Array(items)
}

fn serialize_arguments(args: &ast::Arguments, idx: &LineIndex) -> Value {
    let posonlyargs: Vec<Value> = args
        .posonlyargs
        .iter()
        .map(|a| serialize_arg_with_default(a, idx))
        .collect();
    let regular_args: Vec<Value> = args
        .args
        .iter()
        .map(|a| serialize_arg_with_default(a, idx))
        .collect();
    let kwonlyargs: Vec<Value> = args
        .kwonlyargs
        .iter()
        .map(|a| serialize_arg_with_default(a, idx))
        .collect();
    json!({
        "type": "Arguments",
        "posonlyargs": posonlyargs,
        "args": regular_args,
        "vararg": args.vararg.as_ref().map(|a| serialize_arg(a, idx)),
        "kwonlyargs": kwonlyargs,
        "kwarg": args.kwarg.as_ref().map(|a| serialize_arg(a, idx))
    })
}

fn serialize_arg_with_default(awd: &ast::ArgWithDefault, idx: &LineIndex) -> Value {
    json!({
        "type": "ArgWithDefault",
        "arg": serialize_arg(&awd.def, idx),
        "default": awd.default.as_ref().map(|d| serialize_expr(d, idx))
    })
}

fn serialize_arg(arg: &ast::Arg, idx: &LineIndex) -> Value {
    json!({
        "type": "Arg",
        "arg": arg.arg.as_str(),
        "annotation": arg.annotation.as_ref().map(|a| serialize_expr(a, idx)),
        "type_comment": arg.type_comment,
        "span": serialize_span(arg.range(), idx)
    })
}

fn serialize_keyword(kw: &ast::Keyword, idx: &LineIndex) -> Value {
    json!({
        "type": "Keyword",
        "arg": kw.arg.as_ref().map(|id| id.as_str()),
        "value": serialize_expr(&kw.value, idx),
        "span": serialize_span(kw.range(), idx)
    })
}

fn serialize_alias(alias: &ast::Alias, idx: &LineIndex) -> Value {
    json!({
        "type": "Alias",
        "name": alias.name.as_str(),
        "asname": alias.asname.as_ref().map(|id| id.as_str()),
        "span": serialize_span(alias.range(), idx)
    })
}

fn serialize_with_item(wi: &ast::WithItem, idx: &LineIndex) -> Value {
    json!({
        "type": "WithItem",
        "context_expr": serialize_expr(&wi.context_expr, idx),
        "optional_vars": wi.optional_vars.as_ref().map(|v| serialize_expr(v, idx))
    })
}

fn serialize_except_handler(handler: &ast::ExceptHandler, idx: &LineIndex) -> Value {
    match handler {
        ast::ExceptHandler::ExceptHandler(h) => {
            json!({
                "type": "ExceptHandler",
                "exc_type": h.type_.as_ref().map(|e| serialize_expr(e, idx)),
                "name": h.name.as_ref().map(|id| id.as_str()),
                "body": serialize_body(&h.body, idx),
                "span": serialize_span(h.range(), idx)
            })
        }
    }
}

fn serialize_match_case(case: &ast::MatchCase, idx: &LineIndex) -> Value {
    json!({
        "type": "MatchCase",
        "pattern": serialize_pattern(&case.pattern, idx),
        "guard": case.guard.as_ref().map(|e| serialize_expr(e, idx)),
        "body": serialize_body(&case.body, idx)
    })
}

fn serialize_comprehension(comp: &ast::Comprehension, idx: &LineIndex) -> Value {
    let ifs: Vec<Value> = comp.ifs.iter().map(|e| serialize_expr(e, idx)).collect();
    json!({
        "type": "Comprehension",
        "target": serialize_expr(&comp.target, idx),
        "iter": serialize_expr(&comp.iter, idx),
        "ifs": ifs,
        "is_async": comp.is_async
    })
}

// ---------------------------------------------------------------------------
// Pattern (match statement patterns)
// ---------------------------------------------------------------------------

fn serialize_pattern(pattern: &ast::Pattern, idx: &LineIndex) -> Value {
    match pattern {
        ast::Pattern::MatchValue(p) => {
            json!({
                "type": "MatchValue",
                "value": serialize_expr(&p.value, idx),
                "span": serialize_span(p.range(), idx)
            })
        }
        ast::Pattern::MatchSingleton(p) => {
            json!({
                "type": "MatchSingleton",
                "value": serialize_constant(&p.value),
                "span": serialize_span(p.range(), idx)
            })
        }
        ast::Pattern::MatchSequence(p) => {
            let patterns: Vec<Value> =
                p.patterns.iter().map(|pat| serialize_pattern(pat, idx)).collect();
            json!({
                "type": "MatchSequence",
                "patterns": patterns,
                "span": serialize_span(p.range(), idx)
            })
        }
        ast::Pattern::MatchMapping(p) => {
            let keys: Vec<Value> =
                p.keys.iter().map(|e| serialize_expr(e, idx)).collect();
            let patterns: Vec<Value> =
                p.patterns.iter().map(|pat| serialize_pattern(pat, idx)).collect();
            json!({
                "type": "MatchMapping",
                "keys": keys,
                "patterns": patterns,
                "rest": p.rest.as_ref().map(|id| id.as_str()),
                "span": serialize_span(p.range(), idx)
            })
        }
        ast::Pattern::MatchClass(p) => {
            let patterns: Vec<Value> =
                p.patterns.iter().map(|pat| serialize_pattern(pat, idx)).collect();
            let kwd_attrs: Vec<Value> =
                p.kwd_attrs.iter().map(|id| json!(id.as_str())).collect();
            let kwd_patterns: Vec<Value> =
                p.kwd_patterns.iter().map(|pat| serialize_pattern(pat, idx)).collect();
            json!({
                "type": "MatchClass",
                "cls": serialize_expr(&p.cls, idx),
                "patterns": patterns,
                "kwd_attrs": kwd_attrs,
                "kwd_patterns": kwd_patterns,
                "span": serialize_span(p.range(), idx)
            })
        }
        ast::Pattern::MatchStar(p) => {
            json!({
                "type": "MatchStar",
                "name": p.name.as_ref().map(|id| id.as_str()),
                "span": serialize_span(p.range(), idx)
            })
        }
        ast::Pattern::MatchAs(p) => {
            json!({
                "type": "MatchAs",
                "pattern": p.pattern.as_ref().map(|pat| serialize_pattern(pat, idx)),
                "name": p.name.as_ref().map(|id| id.as_str()),
                "span": serialize_span(p.range(), idx)
            })
        }
        ast::Pattern::MatchOr(p) => {
            let patterns: Vec<Value> =
                p.patterns.iter().map(|pat| serialize_pattern(pat, idx)).collect();
            json!({
                "type": "MatchOr",
                "patterns": patterns,
                "span": serialize_span(p.range(), idx)
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Type parameters (PEP 695)
// ---------------------------------------------------------------------------

fn serialize_type_param(tp: &ast::TypeParam, idx: &LineIndex) -> Value {
    match tp {
        ast::TypeParam::TypeVar(tv) => {
            json!({
                "type": "TypeVar",
                "name": tv.name.as_str(),
                "bound": tv.bound.as_ref().map(|e| serialize_expr(e, idx)),
                "span": serialize_span(tv.range(), idx)
            })
        }
        ast::TypeParam::ParamSpec(ps) => {
            json!({
                "type": "ParamSpec",
                "name": ps.name.as_str(),
                "span": serialize_span(ps.range(), idx)
            })
        }
        ast::TypeParam::TypeVarTuple(tvt) => {
            json!({
                "type": "TypeVarTuple",
                "name": tvt.name.as_str(),
                "span": serialize_span(tvt.range(), idx)
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Enum serializers (operators, contexts, etc.)
// ---------------------------------------------------------------------------

fn serialize_boolop(op: &ast::BoolOp) -> Value {
    match op {
        ast::BoolOp::And => json!("And"),
        ast::BoolOp::Or => json!("Or"),
    }
}

fn serialize_operator(op: &ast::Operator) -> Value {
    match op {
        ast::Operator::Add => json!("Add"),
        ast::Operator::Sub => json!("Sub"),
        ast::Operator::Mult => json!("Mult"),
        ast::Operator::MatMult => json!("MatMult"),
        ast::Operator::Div => json!("Div"),
        ast::Operator::Mod => json!("Mod"),
        ast::Operator::Pow => json!("Pow"),
        ast::Operator::LShift => json!("LShift"),
        ast::Operator::RShift => json!("RShift"),
        ast::Operator::BitOr => json!("BitOr"),
        ast::Operator::BitXor => json!("BitXor"),
        ast::Operator::BitAnd => json!("BitAnd"),
        ast::Operator::FloorDiv => json!("FloorDiv"),
    }
}

fn serialize_unaryop(op: &ast::UnaryOp) -> Value {
    match op {
        ast::UnaryOp::Invert => json!("Invert"),
        ast::UnaryOp::Not => json!("Not"),
        ast::UnaryOp::UAdd => json!("UAdd"),
        ast::UnaryOp::USub => json!("USub"),
    }
}

fn serialize_cmpop(op: &ast::CmpOp) -> Value {
    match op {
        ast::CmpOp::Eq => json!("Eq"),
        ast::CmpOp::NotEq => json!("NotEq"),
        ast::CmpOp::Lt => json!("Lt"),
        ast::CmpOp::LtE => json!("LtE"),
        ast::CmpOp::Gt => json!("Gt"),
        ast::CmpOp::GtE => json!("GtE"),
        ast::CmpOp::Is => json!("Is"),
        ast::CmpOp::IsNot => json!("IsNot"),
        ast::CmpOp::In => json!("In"),
        ast::CmpOp::NotIn => json!("NotIn"),
    }
}

fn serialize_expr_context(ctx: &ast::ExprContext) -> Value {
    match ctx {
        ast::ExprContext::Load => json!("Load"),
        ast::ExprContext::Store => json!("Store"),
        ast::ExprContext::Del => json!("Del"),
    }
}

fn serialize_conversion_flag(flag: &ast::ConversionFlag) -> Value {
    match flag {
        ast::ConversionFlag::None => json!(-1),
        ast::ConversionFlag::Str => json!("s"),
        ast::ConversionFlag::Ascii => json!("a"),
        ast::ConversionFlag::Repr => json!("r"),
    }
}

// ---------------------------------------------------------------------------
// Constant values
// ---------------------------------------------------------------------------

fn serialize_constant(constant: &ast::Constant) -> Value {
    match constant {
        ast::Constant::None => Value::Null,
        ast::Constant::Bool(b) => json!(b),
        ast::Constant::Str(s) => json!(s),
        ast::Constant::Bytes(b) => {
            // Represent bytes as an array of u8 values
            json!(b)
        }
        ast::Constant::Int(i) => {
            // BigInt: try to fit into i64, otherwise use string
            json!(i.to_string())
        }
        ast::Constant::Float(f) => json!(f),
        ast::Constant::Complex { real, imag } => {
            json!({"real": real, "imag": imag})
        }
        ast::Constant::Ellipsis => json!("..."),
        ast::Constant::Tuple(items) => {
            let vals: Vec<Value> = items.iter().map(serialize_constant).collect();
            json!(vals)
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_function() {
        let source = "def hello(name):\n    return name\n";
        let result = parse_python_source(source, "<test>");
        assert!(result.is_ok(), "Parse failed: {:?}", result.err());
        let json_str = result.unwrap();
        let val: Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(val["type"], "Module");
        assert_eq!(val["body"][0]["type"], "FunctionDef");
        assert_eq!(val["body"][0]["name"], "hello");
    }

    #[test]
    fn test_parse_class() {
        let source = "class Foo(Bar):\n    pass\n";
        let result = parse_python_source(source, "<test>");
        assert!(result.is_ok());
        let val: Value = serde_json::from_str(&result.unwrap()).unwrap();
        assert_eq!(val["body"][0]["type"], "ClassDef");
        assert_eq!(val["body"][0]["name"], "Foo");
    }

    #[test]
    fn test_parse_import() {
        let source = "from os.path import join as pjoin\nimport sys\n";
        let result = parse_python_source(source, "<test>");
        assert!(result.is_ok());
        let val: Value = serde_json::from_str(&result.unwrap()).unwrap();
        assert_eq!(val["body"][0]["type"], "ImportFrom");
        assert_eq!(val["body"][0]["module"], "os.path");
        assert_eq!(val["body"][1]["type"], "Import");
    }

    #[test]
    fn test_parse_expressions() {
        let source = "x = 1 + 2\ny = [i for i in range(10)]\n";
        let result = parse_python_source(source, "<test>");
        assert!(result.is_ok());
        let val: Value = serde_json::from_str(&result.unwrap()).unwrap();
        assert_eq!(val["body"][0]["type"], "Assign");
        assert_eq!(val["body"][0]["value"]["type"], "BinOp");
        assert_eq!(val["body"][1]["value"]["type"], "ListComp");
    }

    #[test]
    fn test_span_positions() {
        let source = "x = 1\n";
        let result = parse_python_source(source, "<test>");
        assert!(result.is_ok());
        let val: Value = serde_json::from_str(&result.unwrap()).unwrap();
        let span = &val["body"][0]["span"];
        assert_eq!(span["start"]["line"], 1);
        assert_eq!(span["start"]["col"], 0);
    }

    #[test]
    fn test_parse_error() {
        let source = "def (broken";
        let result = parse_python_source(source, "<test>");
        assert!(result.is_err());
    }
}
