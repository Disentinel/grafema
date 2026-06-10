//! Layer 3 — parser extensions for Appendix-A syntax.
//!
//! Extends the v1 parser (`crate::datalog::parser`) with the Appendix-A annotation set
//! (`@tag`, `@materialize`, `@tag_from`, `@lattice`), the `#requires` pragma, the `=>`
//! lattice head form, and aggregates. Gate A requires at minimum `@materialize` plus
//! plain (annotation-free) rules, `#requires(engine >= 2)` pragma handling (parse +
//! reject unsatisfiable), and multi-clause rules (the same head predicate with multiple
//! bodies). Invariant I5: every rejected input carries a stable `E-*` error code, never
//! a bare string.
//!
//! ## Reuse strategy
//!
//! The v1 parser (`crate::datalog::parser`) owns the rule/body/literal/term grammar and
//! is shared verbatim — this layer never re-implements it. parser_ext is a *preprocessor
//! + framing* layer: it splits a `.dl` file into pragmas, per-item annotation blocks, and
//! rule clauses (clause boundaries are the `.` terminators that v1 already understands),
//! delegates each rule clause to `crate::datalog::parser::parse_rule`, and attaches the
//! parsed annotations + pragmas to an [`Item`]/[`ExtProgram`]. Multi-clause rules fall out
//! naturally: each clause is a separate [`Rule`] (v1 already groups by head predicate via
//! `Program::rules_for`), and the engine's executor unions the bodies.
//!
//! ## Gate A coverage vs. deferral
//!
//! - `#requires(engine >= N)` — **parsed and enforced**. `engine` is the only supported
//!   capability key in Gate A; the engine version is `2`. An unsatisfiable constraint
//!   (e.g. `engine >= 3`) is rejected with `E-PRAGMA-002`. An unknown key or malformed
//!   comparison is `E-PRAGMA-001`.
//! - `@materialize(...)` — **parsed** into [`Annotation::Materialize`] with its key/value
//!   pairs (Gate B consumes the write-back; Gate A carries it through stratification).
//! - `@tag(...)`, `@tag_from(...)`, `@lattice(...)` — **parsed and retained** as
//!   [`Annotation`] variants (raw payloads). Their *semantics* (Count/Conf/Product tags,
//!   lattice joins) are Gate C and are not interpreted here — they round-trip so the
//!   stratifier/executor can reject or defer them with a stable code rather than a parse
//!   failure. This keeps Gate-A `.dl` files that only use `@materialize` + plain rules
//!   fully functional while not silently dropping forward-looking annotations.
//! - `=>` lattice head (`head(Terms => Var)`) — **parsed**: the lattice payload variable
//!   is split off the head and recorded on the [`Item`]; the residual head (without the
//!   `=> Var`) is handed to the v1 rule parser. Lattice *evaluation* is Gate C.
//! - Aggregates (`Var = agg { ... }`) — **detected and rejected** at Gate A with
//!   `E-AGG-001` (aggregation is a Gate C executor feature). They are recognized so the
//!   rejection is explicit (I5), never a confusing downstream parse error.

use crate::datalog::{parse_rule as v1_parse_rule, ParseError as V1ParseError, Rule};

/// The engine version this build implements. `#requires(engine >= N)` is satisfiable
/// iff `N <= ENGINE_VERSION`.
pub const ENGINE_VERSION: u64 = 2;

/// A stable, machine-readable error code (invariant I5).
///
/// Every rejection in parser_ext carries one of these. The taxonomy mirrors the spec
/// §12 families with a parser-local `E-PARSE-*`/`E-PRAGMA-*`/`E-ANNOT-*`/`E-AGG-*` split.
/// Codes never change meaning once shipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// Malformed item/rule syntax that the v1 grammar could not parse.
    Parse,
    /// `#requires` pragma is syntactically malformed (bad key/comparator/value).
    PragmaSyntax,
    /// `#requires` pragma is syntactically valid but its constraint cannot be satisfied
    /// by this engine build (e.g. `engine >= 3` against `ENGINE_VERSION == 2`).
    PragmaUnsatisfiable,
    /// An annotation is malformed (unknown annotation name, or bad key/value payload).
    AnnotationSyntax,
    /// An aggregate (`Var = agg { ... }`) was used. Recognized but deferred to Gate C.
    AggregateUnsupported,
    /// A `=>` lattice head was malformed (e.g. `=>` not followed by a single variable).
    LatticeHeadSyntax,
}

impl ErrorCode {
    /// The stable string form emitted in diagnostics and conformance manifests.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Parse => "E-PARSE-001",
            ErrorCode::PragmaSyntax => "E-PRAGMA-001",
            ErrorCode::PragmaUnsatisfiable => "E-PRAGMA-002",
            ErrorCode::AnnotationSyntax => "E-ANNOT-001",
            ErrorCode::AggregateUnsupported => "E-AGG-001",
            ErrorCode::LatticeHeadSyntax => "E-ANNOT-002",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A coded parse error (invariant I5): a stable [`ErrorCode`] plus a human-readable
/// detail and a 0-based byte offset into the source for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtParseError {
    /// Stable taxonomy code — the load-bearing, machine-checkable field.
    pub code: ErrorCode,
    /// One-line human detail (never the sole signal; the code is authoritative).
    pub detail: String,
    /// 0-based byte offset into the source where the error was detected.
    pub position: usize,
}

impl ExtParseError {
    fn new(code: ErrorCode, detail: impl Into<String>, position: usize) -> Self {
        ExtParseError {
            code,
            detail: detail.into(),
            position,
        }
    }

    /// Adapt a v1 parse error into a coded v2 error (`E-PARSE-001`), preserving its
    /// position (offset-shifted by the clause's start in the source) and message.
    fn from_v1(err: &V1ParseError, base: usize) -> Self {
        ExtParseError {
            code: ErrorCode::Parse,
            detail: err.message.clone(),
            position: base + err.position,
        }
    }
}

impl std::fmt::Display for ExtParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at {}: {}", self.code, self.position, self.detail)
    }
}

impl std::error::Error for ExtParseError {}

/// A comparison operator in a `#requires` pragma.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cmp {
    Eq,
    Ge,
    Gt,
    Le,
    Lt,
}

impl Cmp {
    fn eval(self, lhs: u64, rhs: u64) -> bool {
        match self {
            Cmp::Eq => lhs == rhs,
            Cmp::Ge => lhs >= rhs,
            Cmp::Gt => lhs > rhs,
            Cmp::Le => lhs <= rhs,
            Cmp::Lt => lhs < rhs,
        }
    }
}

/// A parsed `#requires(key cmp value)` pragma.
///
/// Gate A understands the `engine` key (compared against [`ENGINE_VERSION`]). The
/// constraint is checked at parse time; an unsatisfiable one is `E-PRAGMA-002`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requires {
    /// Capability key. Gate A: only `"engine"`.
    pub key: String,
    /// Comparison operator.
    pub cmp: Cmp,
    /// Right-hand numeric value.
    pub value: u64,
}

/// A single `key = value` pair inside an annotation's parenthesised payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KvPair {
    pub key: String,
    pub value: String,
}

/// An Appendix-A annotation attached to a rule item.
///
/// Gate A parses and retains all four variants. Only `Materialize` carries
/// Gate-A-relevant semantics (stratification dependency); `Tag`/`TagFrom`/`Lattice`
/// round-trip their raw payloads for Gate C without being interpreted here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Annotation {
    /// `@tag(tagexpr)` — provenance tag (Gate C semantics). Raw `tagexpr` text retained.
    Tag(String),
    /// `@tag_from(kvpairs)` — tag-from-attribute binding (Gate C). Raw pairs retained.
    TagFrom(Vec<KvPair>),
    /// `@materialize(kvpairs [, meta(names)])` — project the predicate to real
    /// edges/nodes (Gate B write-back). `pairs` (e.g. `edge_type = "DEPENDS_ON"`) are
    /// retained for stratification; `meta` holds the OPTIONAL `meta(name1, name2, …)`
    /// group's field names in source order — the i-th name projects head column `2 + i`
    /// into the written edge's metadata (see `materialize.rs` module docs). Programs
    /// without a `meta(...)` group parse exactly as before (`meta` is empty).
    Materialize {
        /// The `key = value` pairs of the payload.
        pairs: Vec<KvPair>,
        /// The `meta(...)` group's field names, in order. Empty when absent.
        meta: Vec<String>,
    },
    /// `@materialize_node(kvpairs [, meta(names)])` — project the predicate to real
    /// graph NODES (the node twin of `Materialize`). `pairs` carry `node_type = "T"`
    /// (required downstream, `E-MAT-008`) and the optional `mode = "additive"|"exclusive"`;
    /// `meta` names project head columns `3 + i` into the written node's metadata. The
    /// head shape is `p(SemanticId, Name, File, MetaCol…)` — arity `3 + len(meta)`
    /// (see `materialize.rs` module docs). The payload grammar is byte-identical to
    /// `@materialize` ([`parse_materialize_payload`]), including the `_`-prefix
    /// reservation of provenance keys.
    MaterializeNode {
        /// The `key = value` pairs of the payload.
        pairs: Vec<KvPair>,
        /// The `meta(...)` group's field names, in order. Empty when absent.
        meta: Vec<String>,
    },
    /// `@lattice(kvpairs)` — lattice value join config (Gate C). Raw pairs retained.
    Lattice(Vec<KvPair>),
}

/// A rule plus its annotations and (optional) lattice payload variable.
///
/// One [`Item`] is one rule *clause*. Multi-clause rules (same head predicate, multiple
/// bodies) yield multiple `Item`s — there is no merging at parse time; the engine groups
/// by head predicate downstream (as v1 `Program::rules_for` already does).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// Annotations preceding this rule (in source order). Empty for plain rules.
    pub annotations: Vec<Annotation>,
    /// The rule itself, parsed by the shared v1 grammar.
    pub rule: Rule,
    /// The `=> Var` lattice payload variable, if the head used the `=>` form. The v1
    /// `rule` carries the head *without* the payload column; lattice evaluation (Gate C)
    /// reads this field. `None` for ordinary heads.
    pub lattice_payload: Option<String>,
}

/// A parsed v2 program: pragmas + annotated rule items.
///
/// This is the parser_ext output that the stratifier (Layer 4) consumes. The `rules`
/// accessor projects the bare v1 [`Rule`]s for code paths that only need the logic
/// program (executor, safety checks) without the annotation metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtProgram {
    /// `#requires` pragmas (all satisfiable — unsatisfiable ones are rejected at parse).
    pub requires: Vec<Requires>,
    /// Annotated rule items in source order.
    pub items: Vec<Item>,
}

impl ExtProgram {
    /// Borrow the bare v1 rules (drops annotations/pragmas). The executor and safety
    /// checks consume this; stratification consumes the full `items`/`requires`.
    pub fn rules(&self) -> Vec<&Rule> {
        self.items.iter().map(|it| &it.rule).collect()
    }
}

// ============================================================================
// Lexical helpers — a thin tokenizer over the source that frames items but
// defers the rule grammar itself to the v1 parser.
// ============================================================================

/// Cursor over the source used to frame pragmas, annotations, and rule clauses.
struct Framer<'a> {
    input: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Framer<'a> {
    fn new(input: &'a str) -> Self {
        Framer {
            input,
            bytes: input.as_bytes(),
            pos: 0,
        }
    }

    fn rest(&self) -> &'a str {
        &self.input[self.pos..]
    }

    /// Skip whitespace and `%`-to-end-of-line comments (matching v1 comment syntax).
    fn skip_trivia(&mut self) {
        loop {
            // Whitespace.
            while self.pos < self.bytes.len() {
                let c = self.bytes[self.pos];
                if (c as char).is_whitespace() {
                    self.pos += 1;
                } else {
                    break;
                }
            }
            // `%` line comment.
            if self.pos < self.bytes.len() && self.bytes[self.pos] == b'%' {
                while self.pos < self.bytes.len() && self.bytes[self.pos] != b'\n' {
                    self.pos += 1;
                }
                continue;
            }
            break;
        }
    }

    fn at_end(&mut self) -> bool {
        self.skip_trivia();
        self.pos >= self.bytes.len()
    }

    fn peek_byte(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    /// Read a `#requires(...)` pragma. Cursor is positioned at the `#`.
    fn read_pragma(&mut self) -> Result<Requires, ExtParseError> {
        let start = self.pos;
        // Consume `#requires`.
        if !self.rest().starts_with("#requires") {
            // Only `#requires` is supported in Gate A.
            return Err(ExtParseError::new(
                ErrorCode::PragmaSyntax,
                "only '#requires' pragma is supported",
                start,
            ));
        }
        self.pos += "#requires".len();
        self.skip_trivia();
        if self.peek_byte() != Some(b'(') {
            return Err(ExtParseError::new(
                ErrorCode::PragmaSyntax,
                "expected '(' after #requires",
                self.pos,
            ));
        }
        self.pos += 1;
        let inner_start = self.pos;
        let close = self.rest().find(')').ok_or_else(|| {
            ExtParseError::new(ErrorCode::PragmaSyntax, "unterminated #requires", inner_start)
        })?;
        let inner = &self.input[inner_start..inner_start + close];
        self.pos = inner_start + close + 1; // consume ')'
        parse_requires_inner(inner, inner_start)
    }

    /// Read one `@annotation(...)`. Cursor is positioned at the `@`.
    fn read_annotation(&mut self) -> Result<Annotation, ExtParseError> {
        let at = self.pos;
        self.pos += 1; // consume '@'
        let name_start = self.pos;
        while self.pos < self.bytes.len() {
            let c = self.bytes[self.pos] as char;
            if c.is_alphanumeric() || c == '_' {
                self.pos += 1;
            } else {
                break;
            }
        }
        let name = &self.input[name_start..self.pos];
        if name.is_empty() {
            return Err(ExtParseError::new(
                ErrorCode::AnnotationSyntax,
                "expected annotation name after '@'",
                at,
            ));
        }
        self.skip_trivia();
        if self.peek_byte() != Some(b'(') {
            return Err(ExtParseError::new(
                ErrorCode::AnnotationSyntax,
                format!("expected '(' after @{name}"),
                self.pos,
            ));
        }
        self.pos += 1;
        let inner_start = self.pos;
        // Balanced-paren payload scan (string-literal aware): the payload may itself
        // contain a parenthesised group (`@materialize(…, meta(method, line))`), so the
        // closing `)` is the one that returns the depth to zero — not the first one.
        let mut depth: usize = 1;
        let mut in_string = false;
        while self.pos < self.bytes.len() && depth > 0 {
            let c = self.bytes[self.pos];
            if in_string {
                if c == b'"' {
                    in_string = false;
                }
            } else {
                match c {
                    b'"' => in_string = true,
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
            }
            self.pos += 1;
        }
        if depth > 0 {
            return Err(ExtParseError::new(
                ErrorCode::AnnotationSyntax,
                format!("unterminated @{name}(...)"),
                inner_start,
            ));
        }
        // `self.pos` sits just past the matching ')'.
        let inner = &self.input[inner_start..self.pos - 1];

        match name {
            "tag" => Ok(Annotation::Tag(inner.trim().to_string())),
            "tag_from" => Ok(Annotation::TagFrom(parse_kvpairs(inner, inner_start)?)),
            "materialize" => {
                let (pairs, meta) = parse_materialize_payload(inner, inner_start)?;
                Ok(Annotation::Materialize { pairs, meta })
            }
            "materialize_node" => {
                let (pairs, meta) = parse_materialize_payload(inner, inner_start)?;
                Ok(Annotation::MaterializeNode { pairs, meta })
            }
            "lattice" => Ok(Annotation::Lattice(parse_kvpairs(inner, inner_start)?)),
            other => Err(ExtParseError::new(
                ErrorCode::AnnotationSyntax,
                format!("unknown annotation '@{other}'"),
                at,
            )),
        }
    }

    /// Read one rule clause: everything up to and including the terminating `.`,
    /// respecting `.` inside string literals (so `node(X, "a.b")` is one clause).
    /// Returns the clause text and its start offset in the source.
    fn read_clause(&mut self) -> Result<(&'a str, usize), ExtParseError> {
        self.skip_trivia();
        let start = self.pos;
        let mut in_string = false;
        while self.pos < self.bytes.len() {
            let c = self.bytes[self.pos];
            if in_string {
                if c == b'"' {
                    in_string = false;
                }
                self.pos += 1;
                continue;
            }
            match c {
                b'"' => {
                    in_string = true;
                    self.pos += 1;
                }
                b'%' => {
                    // Line comment inside a clause: skip to newline.
                    while self.pos < self.bytes.len() && self.bytes[self.pos] != b'\n' {
                        self.pos += 1;
                    }
                }
                b'.' => {
                    // A '.' flanked by digits is a decimal point inside a numeric literal
                    // (e.g. `gt(S, 0.5)`), NOT the clause terminator — keep scanning. Datalog
                    // has no `.`-member syntax, so a digit-flanked dot is unambiguously a float.
                    let prev_digit =
                        self.pos > start && self.bytes[self.pos - 1].is_ascii_digit();
                    let next_digit = self.pos + 1 < self.bytes.len()
                        && self.bytes[self.pos + 1].is_ascii_digit();
                    if prev_digit && next_digit {
                        self.pos += 1;
                    } else {
                        self.pos += 1; // include the terminator
                        return Ok((&self.input[start..self.pos], start));
                    }
                }
                _ => self.pos += 1,
            }
        }
        Err(ExtParseError::new(
            ErrorCode::Parse,
            "rule clause missing terminating '.'",
            start,
        ))
    }
}

/// Parse the inside of a `#requires(...)`: `key cmp value`.
fn parse_requires_inner(inner: &str, base: usize) -> Result<Requires, ExtParseError> {
    let trimmed = inner.trim();
    // Find the comparator. Order matters: two-char before one-char.
    let two_char = [(">=", Cmp::Ge), ("<=", Cmp::Le)];
    let one_char = [(">", Cmp::Gt), ("<", Cmp::Lt), ("=", Cmp::Eq)];

    let mut found: Option<(usize, usize, Cmp)> = None;
    for (op, cmp) in two_char {
        if let Some(idx) = trimmed.find(op) {
            found = Some((idx, idx + op.len(), cmp));
            break;
        }
    }
    if found.is_none() {
        for (op, cmp) in one_char {
            if let Some(idx) = trimmed.find(op) {
                found = Some((idx, idx + op.len(), cmp));
                break;
            }
        }
    }
    let (op_start, op_end, cmp) = found.ok_or_else(|| {
        ExtParseError::new(
            ErrorCode::PragmaSyntax,
            "expected a comparison operator (>=, <=, >, <, =) in #requires",
            base,
        )
    })?;

    let key = trimmed[..op_start].trim().to_string();
    let value_str = trimmed[op_end..].trim();
    if key.is_empty() {
        return Err(ExtParseError::new(
            ErrorCode::PragmaSyntax,
            "missing key in #requires",
            base,
        ));
    }
    let value: u64 = value_str.parse().map_err(|_| {
        ExtParseError::new(
            ErrorCode::PragmaSyntax,
            format!("expected an integer value in #requires, found '{value_str}'"),
            base,
        )
    })?;

    let req = Requires { key, cmp, value };

    // Gate A enforces the `engine` capability at parse time.
    if req.key == "engine" {
        if !req.cmp.eval(ENGINE_VERSION, req.value) {
            return Err(ExtParseError::new(
                ErrorCode::PragmaUnsatisfiable,
                format!(
                    "#requires(engine {} {}) cannot be satisfied: this engine is version {ENGINE_VERSION}",
                    cmp_str(req.cmp),
                    req.value
                ),
                base,
            ));
        }
    } else {
        return Err(ExtParseError::new(
            ErrorCode::PragmaSyntax,
            format!("unknown #requires capability '{}'", req.key),
            base,
        ));
    }

    Ok(req)
}

fn cmp_str(cmp: Cmp) -> &'static str {
    match cmp {
        Cmp::Eq => "=",
        Cmp::Ge => ">=",
        Cmp::Gt => ">",
        Cmp::Le => "<=",
        Cmp::Lt => "<",
    }
}

/// Parse `key = value, key = value, ...` inside an annotation payload.
///
/// Values may be quoted strings (`edge_type = "DEPENDS_ON"`), bare identifiers, or
/// `$`-prefixed config references (`default = $deploy.x`); the raw value text (quotes
/// stripped for strings) is retained verbatim for Gate C interpretation.
fn parse_kvpairs(inner: &str, base: usize) -> Result<Vec<KvPair>, ExtParseError> {
    let trimmed = inner.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let mut pairs = Vec::new();
    for part in split_top_level_commas(trimmed) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let eq = part.find('=').ok_or_else(|| {
            ExtParseError::new(
                ErrorCode::AnnotationSyntax,
                format!("expected 'key = value' in annotation, found '{part}'"),
                base,
            )
        })?;
        let key = part[..eq].trim().to_string();
        let raw_value = part[eq + 1..].trim();
        if key.is_empty() {
            return Err(ExtParseError::new(
                ErrorCode::AnnotationSyntax,
                "empty annotation key",
                base,
            ));
        }
        let value = if raw_value.len() >= 2
            && raw_value.starts_with('"')
            && raw_value.ends_with('"')
        {
            raw_value[1..raw_value.len() - 1].to_string()
        } else {
            raw_value.to_string()
        };
        pairs.push(KvPair { key, value });
    }
    Ok(pairs)
}

/// Split on commas that are not inside a string literal or a parenthesised group
/// (`edge_type = "T", meta(method, line)` splits into two parts, not three).
fn split_top_level_commas(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut in_string = false;
    let mut depth: usize = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => in_string = !in_string,
            b'(' if !in_string => depth += 1,
            b')' if !in_string => depth = depth.saturating_sub(1),
            b',' if !in_string && depth == 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&s[start..]);
    parts
}

/// Parse the `@materialize(...)` payload: ordinary `key = value` pairs plus at most one
/// `meta(name1, name2, …)` group naming the head columns (beyond the two edge endpoints)
/// to project into the written edge's metadata, in order.
///
/// Backward compatible by construction: a payload without `meta(...)` takes exactly the
/// [`parse_kvpairs`] path per part. Rejections (all `E-ANNOT-001`, I5): a duplicate
/// `meta(...)` group, an empty `meta()`, a name that is not a plain identifier, a
/// duplicate name, or a `_`-prefixed name (reserved for the provenance stamp's
/// `_source`/`_generation` keys).
fn parse_materialize_payload(
    inner: &str,
    base: usize,
) -> Result<(Vec<KvPair>, Vec<String>), ExtParseError> {
    let trimmed = inner.trim();
    let mut pairs = Vec::new();
    let mut meta: Vec<String> = Vec::new();
    let mut saw_meta = false;
    if trimmed.is_empty() {
        return Ok((pairs, meta));
    }
    for part in split_top_level_commas(trimmed) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        // The meta(...) group: `meta` followed by a parenthesised name list.
        if let Some(rest) = part.strip_prefix("meta") {
            let rest = rest.trim_start();
            if let Some(group) = rest.strip_prefix('(') {
                let Some(names) = group.strip_suffix(')') else {
                    return Err(ExtParseError::new(
                        ErrorCode::AnnotationSyntax,
                        "unterminated meta(...) group in @materialize",
                        base,
                    ));
                };
                if saw_meta {
                    return Err(ExtParseError::new(
                        ErrorCode::AnnotationSyntax,
                        "@materialize allows at most one meta(...) group",
                        base,
                    ));
                }
                saw_meta = true;
                if names.trim().is_empty() {
                    return Err(ExtParseError::new(
                        ErrorCode::AnnotationSyntax,
                        "meta() group requires at least one field name",
                        base,
                    ));
                }
                for name in names.split(',') {
                    let name = name.trim();
                    let valid = !name.is_empty()
                        && name
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_')
                        && !name.starts_with(|c: char| c.is_ascii_digit());
                    if !valid {
                        return Err(ExtParseError::new(
                            ErrorCode::AnnotationSyntax,
                            format!("meta(...) field name '{name}' is not a plain identifier"),
                            base,
                        ));
                    }
                    if name.starts_with('_') {
                        return Err(ExtParseError::new(
                            ErrorCode::AnnotationSyntax,
                            format!(
                                "meta(...) field name '{name}' is reserved: '_'-prefixed keys \
                                 belong to the provenance stamp (_source/_generation)"
                            ),
                            base,
                        ));
                    }
                    if meta.iter().any(|m| m == name) {
                        return Err(ExtParseError::new(
                            ErrorCode::AnnotationSyntax,
                            format!("duplicate meta(...) field name '{name}'"),
                            base,
                        ));
                    }
                    meta.push(name.to_string());
                }
                continue;
            }
        }
        // An ordinary `key = value` pair — delegate to the shared pair grammar.
        pairs.extend(parse_kvpairs(part, base)?);
    }
    Ok((pairs, meta))
}

/// Detect an aggregate body literal (`Var = agg { ... }`) in a clause's body text.
///
/// Aggregation is a Gate C executor feature. Gate A *recognizes* it so the rejection is
/// explicit (I5) with `E-AGG-001` rather than surfacing as a confusing v1 parse error on
/// the `{`/`}` tokens (which the v1 grammar does not understand).
fn clause_has_aggregate(clause: &str) -> bool {
    // An aggregate appears as `<var> = (count|sum|min|max) {`. The `{` is the reliable
    // marker: the v1 grammar has no other use for braces.
    let bytes = clause.as_bytes();
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => in_string = !in_string,
            b'{' if !in_string => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

/// Split a `=>` lattice head off a clause.
///
/// Given a clause whose head uses `head(Terms => Var)`, returns the residual clause with
/// the `=> Var` removed (so v1 can parse the ordinary head) and the payload variable.
/// Returns `None` if there is no top-level `=>` in the head. `=>` may only appear in the
/// head, before `:-`; a `=>` after `:-` (in the body) is malformed → `E-ANNOT-002`.
fn split_lattice_head(clause: &str, base: usize) -> Result<(String, Option<String>), ExtParseError> {
    // Bound the search to the head: everything up to the first top-level `:-`.
    let head_end = find_neck(clause).unwrap_or(clause.len());
    let head = &clause[..head_end];
    let arrow = match find_top_level_arrow(head) {
        Some(idx) => idx,
        None => {
            // No `=>` in the head. Reject a `=>` in the body region explicitly.
            if find_top_level_arrow(&clause[head_end..]).is_some() {
                return Err(ExtParseError::new(
                    ErrorCode::LatticeHeadSyntax,
                    "'=>' may only appear in a rule head",
                    base + head_end,
                ));
            }
            return Ok((clause.to_string(), None));
        }
    };

    // After `=>` expect `Var` then the closing `)` of the head atom.
    let after = &head[arrow + 2..];
    let close_rel = after.find(')').ok_or_else(|| {
        ExtParseError::new(
            ErrorCode::LatticeHeadSyntax,
            "lattice head '=>' must be inside the head atom's parentheses",
            base + arrow,
        )
    })?;
    let var = after[..close_rel].trim();
    if var.is_empty() || !is_variable(var) {
        return Err(ExtParseError::new(
            ErrorCode::LatticeHeadSyntax,
            format!("expected a single variable after '=>', found '{var}'"),
            base + arrow + 2,
        ));
    }

    // Rebuild the clause without `=> Var`: `head_before_arrow` + `)` + rest-after-`)`.
    let head_before = &head[..arrow];
    let head_after_var = &after[close_rel..]; // starts at ')'
    let body_and_rest = &clause[head_end..];
    let rebuilt = format!(
        "{}{}{}",
        head_before.trim_end(),
        head_after_var,
        body_and_rest
    );
    Ok((rebuilt, Some(var.to_string())))
}

/// Find the top-level `:-` (rule neck), skipping string literals. Returns byte index.
fn find_neck(clause: &str) -> Option<usize> {
    let bytes = clause.as_bytes();
    let mut in_string = false;
    let mut i = 0;
    while i + 1 < bytes.len() {
        match bytes[i] {
            b'"' => in_string = !in_string,
            b':' if !in_string && bytes[i + 1] == b'-' => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
}

/// Find a top-level `=>`, skipping string literals. Returns byte index of `=`.
fn find_top_level_arrow(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut in_string = false;
    let mut i = 0;
    while i + 1 < bytes.len() {
        match bytes[i] {
            b'"' => in_string = !in_string,
            b'=' if !in_string && bytes[i + 1] == b'>' => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
}

/// A token is a Datalog variable iff it starts with an uppercase letter or `_` followed
/// by an alphanumeric (matching v1 term lexing), and is otherwise alphanumeric/`_`.
fn is_variable(tok: &str) -> bool {
    let mut chars = tok.chars();
    match chars.next() {
        Some(c) if c.is_uppercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || c == '_')
}

// ============================================================================
// Public API
// ============================================================================

/// Parse a complete Appendix-A `.dl` program: pragmas, then annotated rule items.
///
/// Steps over the source framing pragmas (`#requires`), annotation blocks (`@...`), and
/// rule clauses (terminated by `.`). Each rule clause is parsed by the shared v1 grammar.
/// Returns an [`ExtProgram`]; any rejection carries a stable [`ErrorCode`] (I5).
pub fn parse_ext_program(input: &str) -> Result<ExtProgram, ExtParseError> {
    let mut framer = Framer::new(input);
    let mut requires = Vec::new();
    let mut items = Vec::new();
    let mut pending_annotations: Vec<Annotation> = Vec::new();

    while !framer.at_end() {
        match framer.peek_byte() {
            Some(b'#') => {
                if !pending_annotations.is_empty() {
                    return Err(ExtParseError::new(
                        ErrorCode::PragmaSyntax,
                        "#requires pragma must precede annotations and rules",
                        framer.pos,
                    ));
                }
                requires.push(framer.read_pragma()?);
            }
            Some(b'@') => {
                pending_annotations.push(framer.read_annotation()?);
            }
            _ => {
                let (clause, base) = framer.read_clause()?;
                if clause_has_aggregate(clause) {
                    return Err(ExtParseError::new(
                        ErrorCode::AggregateUnsupported,
                        "aggregates (Var = agg { ... }) are not supported in Gate A",
                        base,
                    ));
                }
                let (residual, lattice_payload) = split_lattice_head(clause, base)?;
                let rule =
                    v1_parse_rule(&residual).map_err(|e| ExtParseError::from_v1(&e, base))?;
                items.push(Item {
                    annotations: std::mem::take(&mut pending_annotations),
                    rule,
                    lattice_payload,
                });
            }
        }
    }

    if !pending_annotations.is_empty() {
        return Err(ExtParseError::new(
            ErrorCode::AnnotationSyntax,
            "annotations are not attached to any rule (trailing annotations at end of file)",
            framer.pos,
        ));
    }

    Ok(ExtProgram { requires, items })
}

/// Parse a single rule clause string (with optional preceding annotations / `=>` head)
/// into an [`Item`]. Convenience wrapper for callers that hold one rule (e.g. a single
/// `guarantees.yaml` `rule:` entry) rather than a whole `.dl` file.
pub fn parse_ext_rule(input: &str) -> Result<Item, ExtParseError> {
    let program = parse_ext_program(input)?;
    if program.items.len() != 1 {
        return Err(ExtParseError::new(
            ErrorCode::Parse,
            format!("expected exactly one rule, found {}", program.items.len()),
            0,
        ));
    }
    if !program.requires.is_empty() {
        return Err(ExtParseError::new(
            ErrorCode::PragmaSyntax,
            "parse_ext_rule does not accept #requires pragmas (use parse_ext_program)",
            0,
        ));
    }
    Ok(program.items.into_iter().next().expect("len == 1 checked"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datalog::Literal;

    fn head_pred(item: &Item) -> &str {
        item.rule.head().predicate()
    }

    #[test]
    fn plain_containment_rule_parses() {
        // function-has-contains shape from .grafema/guarantees.yaml.
        let src = r#"violation(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS")."#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.items.len(), 1);
        let item = &prog.items[0];
        assert_eq!(head_pred(item), "violation");
        assert!(item.annotations.is_empty());
        assert!(item.lattice_payload.is_none());
        assert_eq!(item.rule.body().len(), 2);
        assert!(item.rule.body()[1].is_negative());
    }

    #[test]
    fn multi_negation_scope_rule_parses() {
        // scope-has-parent: five negated literals over one head.
        let src = r#"violation(X) :- node(X, "SCOPE"),
            \+ edge(_, X, "HAS_SCOPE"),
            \+ edge(_, X, "HAS_BODY"),
            \+ edge(_, X, "HAS_CONSEQUENT"),
            \+ edge(_, X, "HAS_ALTERNATE"),
            \+ edge(_, X, "CONTAINS")."#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.items.len(), 1);
        assert_eq!(prog.items[0].rule.body().len(), 6);
    }

    #[test]
    fn multi_clause_same_head_yields_multiple_items() {
        // http-nodes-orphan: two clauses, same head predicate `violation`.
        let src = r#"
            violation(X) :- node(X, "http:route"), \+ edge(_, X, "CONTAINS").
            violation(X) :- node(X, "http:request"), \+ edge(_, X, "CONTAINS").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.items.len(), 2);
        assert_eq!(head_pred(&prog.items[0]), "violation");
        assert_eq!(head_pred(&prog.items[1]), "violation");
    }

    #[test]
    fn orphan_guarantee_two_rule_helper_predicate_parses() {
        // beam-handler-unguarded-tick: a helper predicate `has_guard` plus a `violation`
        // rule that negates it. Two head predicates across two clauses.
        let src = r#"
            has_guard(M) :- edge(M, B, "CONTAINS"), node(B, "BRANCH").
            violation(M) :- edge(M, C, "CONTAINS"), edge(C, _, "SELF_SCHEDULE"), node(M, "MESSAGE_TYPE"), \+ has_guard(M).
        "#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.items.len(), 2);
        assert_eq!(head_pred(&prog.items[0]), "has_guard");
        assert_eq!(head_pred(&prog.items[1]), "violation");
        // The violation rule negates the helper predicate.
        let neg = prog.items[1]
            .rule
            .body()
            .iter()
            .any(|l| matches!(l, Literal::Negative(a) if a.predicate() == "has_guard"));
        assert!(neg, "violation must negate has_guard");
    }

    #[test]
    fn attr_rule_with_gt_builtin_parses() {
        // call-with-args-has-passes-argument: attr + gt builtin + negation.
        // The shared v1 term grammar lexes constants as quoted strings; the comparison
        // threshold round-trips as a `Const`. (Bare numeric literals like `gt(A, 0)` are
        // a v1-grammar gap — see `bare_numeric_term_is_a_v1_grammar_gap` below.)
        let src = r#"violation(X) :- node(X, "CALL"),
            edge(X, _, "CALLS"),
            attr(X, "argCount", A),
            gt(A, "0"),
            \+ edge(X, _, "PASSES_ARGUMENT")."#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.items[0].rule.body().len(), 5);
    }

    #[test]
    fn bare_numeric_term_parses_to_a_typed_literal() {
        // `.grafema/guarantees.yaml` writes `gt(A, 0)` with a bare integer. The shared term
        // grammar now has a numeric-literal production (spec §5): a bare `0`/`3.14` parses to a
        // typed `Term::Lit(Value::Int/Float)` — NOT a string round-trip, NOT a node id — so
        // numeric-comparison guarantee rules evaluate instead of erroring (was E-PARSE-001).
        use crate::datalog::{Term, Value};

        let prog = parse_ext_program(r#"violation(X) :- attr(X, "argCount", A), gt(A, 0)."#)
            .expect("bare integer literal now parses");
        let gt = &prog.items[0].rule.body()[1];
        assert_eq!(gt.atom().predicate(), "gt");
        assert_eq!(gt.atom().args()[1], Term::Lit(Value::Int(0)), "0 → typed Int literal");

        // A decimal point makes it a Float; both stay distinct from the quoted string "0".
        let progf = parse_ext_program(r#"violation(X) :- attr(X, "score", S), gt(S, 0.5)."#)
            .expect("bare float literal parses");
        assert_eq!(progf.items[0].rule.body()[1].atom().args()[1], Term::Lit(Value::Float(0.5)));
    }

    #[test]
    fn requires_engine_satisfiable_is_accepted() {
        let src = r#"#requires(engine >= 2)
            violation(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS")."#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.requires.len(), 1);
        assert_eq!(prog.requires[0].key, "engine");
        assert_eq!(prog.requires[0].cmp, Cmp::Ge);
        assert_eq!(prog.requires[0].value, 2);
        assert_eq!(prog.items.len(), 1);
    }

    #[test]
    fn requires_engine_unsatisfiable_is_rejected_with_code() {
        let src = r#"#requires(engine >= 3)
            violation(X) :- node(X, "FUNCTION")."#;
        let err = parse_ext_program(src).expect_err("must reject");
        assert_eq!(err.code, ErrorCode::PragmaUnsatisfiable);
        assert_eq!(err.code.as_str(), "E-PRAGMA-002");
    }

    #[test]
    fn requires_engine_exact_version_satisfiable() {
        let src = r#"#requires(engine = 2)
            violation(X) :- node(X, "FUNCTION")."#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.requires[0].cmp, Cmp::Eq);
    }

    #[test]
    fn requires_unknown_capability_rejected() {
        let src = r#"#requires(foo >= 1)
            violation(X) :- node(X, "FUNCTION")."#;
        let err = parse_ext_program(src).expect_err("must reject");
        assert_eq!(err.code, ErrorCode::PragmaSyntax);
    }

    #[test]
    fn requires_missing_operator_rejected() {
        let src = r#"#requires(engine 2)
            violation(X) :- node(X, "FUNCTION")."#;
        let err = parse_ext_program(src).expect_err("must reject");
        assert_eq!(err.code, ErrorCode::PragmaSyntax);
    }

    #[test]
    fn materialize_annotation_parses_and_retains_pairs() {
        // From spec §3 worked example.
        let src = r#"@materialize(edge_type = "DEPENDS_ON")
            depends(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.items.len(), 1);
        let anns = &prog.items[0].annotations;
        assert_eq!(anns.len(), 1);
        match &anns[0] {
            Annotation::Materialize { pairs, meta } => {
                assert_eq!(pairs.len(), 1);
                assert_eq!(pairs[0].key, "edge_type");
                assert_eq!(pairs[0].value, "DEPENDS_ON");
                assert!(meta.is_empty(), "no meta(...) group → empty meta");
            }
            other => panic!("expected @materialize, got {other:?}"),
        }
    }

    #[test]
    fn materialize_meta_group_parses_names_in_order() {
        // The full §-syntax: edge_type + mode + meta(...) in one payload; the nested
        // parens and the commas inside meta(...) must not break the framing.
        let src = r#"@materialize(edge_type = "CALLS", mode = "additive", meta(method, line))
            resolved(C, M, Name, L) :- edge(C, M, "CALLS"), attr(C, "name", Name), attr(C, "line", L)."#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.items.len(), 1, "the rule clause after the annotation parses");
        match &prog.items[0].annotations[0] {
            Annotation::Materialize { pairs, meta } => {
                assert_eq!(pairs.len(), 2);
                assert_eq!((pairs[0].key.as_str(), pairs[0].value.as_str()), ("edge_type", "CALLS"));
                assert_eq!((pairs[1].key.as_str(), pairs[1].value.as_str()), ("mode", "additive"));
                assert_eq!(meta, &vec!["method".to_string(), "line".to_string()]);
            }
            other => panic!("expected @materialize, got {other:?}"),
        }
        // The head kept its full arity (4): meta consumes columns 2..; nothing is split off.
        assert_eq!(prog.items[0].rule.head().arity(), 4);
    }

    #[test]
    fn materialize_meta_group_rejections_are_coded() {
        let cases = [
            // Empty group.
            r#"@materialize(edge_type = "T", meta())
               p(A, B) :- edge(A, B, "E")."#,
            // Duplicate field name.
            r#"@materialize(edge_type = "T", meta(m, m))
               p(A, B, X, Y) :- edge(A, B, "E"), attr(A, "name", X), attr(B, "name", Y)."#,
            // Reserved '_'-prefixed name (provenance keys).
            r#"@materialize(edge_type = "T", meta(_source))
               p(A, B, X) :- edge(A, B, "E"), attr(A, "name", X)."#,
            // Not a plain identifier.
            r#"@materialize(edge_type = "T", meta(a-b))
               p(A, B, X) :- edge(A, B, "E"), attr(A, "name", X)."#,
            // Two meta groups.
            r#"@materialize(edge_type = "T", meta(a), meta(b))
               p(A, B, X, Y) :- edge(A, B, "E"), attr(A, "name", X), attr(B, "name", Y)."#,
        ];
        for src in cases {
            let err = parse_ext_program(src).expect_err("must reject");
            assert_eq!(err.code, ErrorCode::AnnotationSyntax, "case: {src}");
        }
    }

    /// `@materialize_node` parses through the SHARED payload grammar: `node_type` /
    /// `mode` pairs plus a `meta(...)` group, framed exactly like `@materialize`
    /// (nested parens, commas inside the group). The variant — not the payload shape —
    /// is what distinguishes node from edge materialization downstream.
    #[test]
    fn materialize_node_annotation_parses_pairs_and_meta() {
        let src = r#"@materialize_node(node_type = "ISSUE", mode = "exclusive", meta(method, receiverType))
            issue(Sid, Name, File, M, T) :- violation(C, T0, M), attr(C, "file", File),
                                            concat("issue::", C, Sid), attr(C, "name", Name), attr(T0, "name", T)."#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.items.len(), 1);
        match &prog.items[0].annotations[0] {
            Annotation::MaterializeNode { pairs, meta } => {
                assert_eq!(pairs.len(), 2);
                assert_eq!((pairs[0].key.as_str(), pairs[0].value.as_str()), ("node_type", "ISSUE"));
                assert_eq!((pairs[1].key.as_str(), pairs[1].value.as_str()), ("mode", "exclusive"));
                assert_eq!(meta, &vec!["method".to_string(), "receiverType".to_string()]);
            }
            other => panic!("expected @materialize_node, got {other:?}"),
        }
    }

    /// The shared payload grammar's rejections apply to `@materialize_node` verbatim
    /// (reserved `_`-prefixed meta names guard the provenance stamp keys).
    #[test]
    fn materialize_node_meta_reserved_name_rejected() {
        let src = r#"@materialize_node(node_type = "ISSUE", meta(_source))
            issue(Sid, N, F, X) :- node(C, "CALL"), attr(C, "name", N), attr(C, "file", F),
                                   concat("i::", C, Sid), attr(C, "line", X)."#;
        let err = parse_ext_program(src).expect_err("must reject");
        assert_eq!(err.code, ErrorCode::AnnotationSyntax);
    }

    /// Backward compatibility of the balanced-paren payload scan: every pre-meta payload
    /// shape (flat pairs, quoted values with commas/parens inside strings) parses as before.
    #[test]
    fn materialize_payload_without_meta_is_unchanged() {
        let src = r#"@materialize(edge_type = "DEPENDS_ON", mode = "exclusive")
            dep(X, Y) :- edge(X, Y, "IMPORTS_FROM (weird, name)")."#;
        let prog = parse_ext_program(src).expect("parse");
        match &prog.items[0].annotations[0] {
            Annotation::Materialize { pairs, meta } => {
                assert_eq!(pairs.len(), 2);
                assert!(meta.is_empty());
            }
            other => panic!("expected @materialize, got {other:?}"),
        }
    }

    #[test]
    fn tag_and_tag_from_annotations_round_trip() {
        let src = r#"@tag(conf * witness)
            @tag_from(attr = "confidence", default = $deploy.default_confidence)
            trusted_dep(X, Y) :- depends(X, Y)."#;
        let prog = parse_ext_program(src).expect("parse");
        let anns = &prog.items[0].annotations;
        assert_eq!(anns.len(), 2);
        assert!(matches!(&anns[0], Annotation::Tag(t) if t == "conf * witness"));
        match &anns[1] {
            Annotation::TagFrom(pairs) => {
                assert_eq!(pairs.len(), 2);
                assert_eq!(pairs[0].key, "attr");
                assert_eq!(pairs[0].value, "confidence");
                assert_eq!(pairs[1].key, "default");
                assert_eq!(pairs[1].value, "$deploy.default_confidence");
            }
            other => panic!("expected @tag_from, got {other:?}"),
        }
    }

    #[test]
    fn lattice_head_arrow_is_split_off() {
        let src = r#"@lattice(value = type_union)
            var_type(X => T) :- depends(X, T)."#;
        let prog = parse_ext_program(src).expect("parse");
        let item = &prog.items[0];
        assert_eq!(item.lattice_payload.as_deref(), Some("T"));
        // The residual head handed to v1 has arity 1 (X), payload split off.
        assert_eq!(item.rule.head().predicate(), "var_type");
        assert_eq!(item.rule.head().arity(), 1);
        assert!(matches!(&item.annotations[0], Annotation::Lattice(_)));
    }

    #[test]
    fn aggregate_is_rejected_with_code() {
        let src = r#"fanin(X, N) :- node(X, "FUNCTION"), N = count { C : edge(C, X, "CALLS") }."#;
        let err = parse_ext_program(src).expect_err("must reject aggregate");
        assert_eq!(err.code, ErrorCode::AggregateUnsupported);
        assert_eq!(err.code.as_str(), "E-AGG-001");
    }

    #[test]
    fn unknown_annotation_rejected_with_code() {
        let src = r#"@bogus(x = 1)
            violation(X) :- node(X, "FUNCTION")."#;
        let err = parse_ext_program(src).expect_err("must reject");
        assert_eq!(err.code, ErrorCode::AnnotationSyntax);
    }

    #[test]
    fn trailing_annotation_without_rule_rejected() {
        let src = r#"@materialize(edge_type = "X")"#;
        let err = parse_ext_program(src).expect_err("must reject");
        assert_eq!(err.code, ErrorCode::AnnotationSyntax);
    }

    #[test]
    fn malformed_rule_carries_parse_code() {
        let src = r#"violation(X :- node(X, "FUNCTION")."#;
        let err = parse_ext_program(src).expect_err("must reject");
        assert_eq!(err.code, ErrorCode::Parse);
    }

    #[test]
    fn dot_inside_string_is_not_a_clause_terminator() {
        // A node type with a dot in the constant must not split the clause early.
        let src = r#"violation(X) :- node(X, "a.b.c"), \+ edge(_, X, "CONTAINS")."#;
        let prog = parse_ext_program(src).expect("parse");
        assert_eq!(prog.items.len(), 1);
        assert_eq!(prog.items[0].rule.body().len(), 2);
    }

    #[test]
    fn parse_ext_rule_single_guarantee_entry() {
        // Mirrors a single guarantees.yaml `rule:` value.
        let src = r#"violation(X) :- node(X, "METHOD"), \+ edge(_, X, "HAS_METHOD")."#;
        let item = parse_ext_rule(src).expect("parse");
        assert_eq!(item.rule.head().predicate(), "violation");
        assert_eq!(item.rule.body().len(), 2);
    }

    #[test]
    fn error_code_strings_are_stable() {
        assert_eq!(ErrorCode::Parse.as_str(), "E-PARSE-001");
        assert_eq!(ErrorCode::PragmaSyntax.as_str(), "E-PRAGMA-001");
        assert_eq!(ErrorCode::PragmaUnsatisfiable.as_str(), "E-PRAGMA-002");
        assert_eq!(ErrorCode::AnnotationSyntax.as_str(), "E-ANNOT-001");
        assert_eq!(ErrorCode::AggregateUnsupported.as_str(), "E-AGG-001");
        assert_eq!(ErrorCode::LatticeHeadSyntax.as_str(), "E-ANNOT-002");
    }
}
