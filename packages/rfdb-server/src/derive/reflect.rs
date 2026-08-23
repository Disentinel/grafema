//! Rules as data — Projection T (the executable reflection).
//!
//! A rule is not program text. It is a set of facts in the store, and the executor reads
//! rules ONLY from there. This module is the single place where a [`Rule`] is turned into
//! those facts and back:
//!
//! * [`encode_rule`] — one rule → the three Projection-T relations `rule/1`,
//!   `conclusion_lit/3`, `premise_lit/3` (the reference's `reflect.ts:149-177`, restricted
//!   to the relations `decodeRules` actually consults).
//! * [`decode_rules`] — the store → executable rules, a literal mirror of the reference's
//!   `decodeRules` (`vendor/rofl-v0/src/reflect.ts:185-216`), including its four different
//!   outcomes on an incomplete reflection (see the function docs).
//!
//! # What is deliberately NOT here
//!
//! Projection F — the audit-only relations `concludes/2`, `has_conclusion/2`,
//! `has_premise/2`, `premise_pos/2`, `premise_neg/2`, `reads_from/2`, `writes_to/2`,
//! `bridge_decl/3`, `uses_builtin/2`. The reference writes them and never reads them back
//! when assembling a rule (`reflect.ts:185-216` names exactly `rule`, `conclusion_lit`,
//! `premise_lit`). Their only consumer is `boot.rofl`, which needs perspectives and
//! arithmetic first. Encoding them now would produce facts with no reader.
//!
//! # Where the facts physically live
//!
//! One `storage_v2` node per reflected fact: `node_type = "$rofl/reflect"`
//! ([`REFLECT_NODE_TYPE`]), the tuple in the node's metadata blob, and the node id derived
//! from the tuple's canonical bytes so writing the same fact twice is idempotent. This is
//! the layer the executor can actually see — it reads through
//! [`crate::derive::storage_glue::StorageView`], which is backed by `storage_v2`; the
//! `facts` layer has no path from the server at all.
//!
//! Because the reflected nodes live in the same node space as ordinary graph nodes, they
//! are excluded from every base-relation read point in `storage_glue` (`node/2`, `attr/3`,
//! typed scans, attr generators). The ONLY door onto them is
//! [`crate::derive::storage_glue::StorageView::reflected_facts`].
//!
//! # Term alphabet
//!
//! The reified alphabet is the reference's (`reflect.ts:60-107`): `$lit(rel, persp, args,
//! temporal)`, `$var("Name")`, `$cons`/`$nil` lists, `$not(lit)`. A ROFL *atom* is a
//! zero-arity [`crate::datalog::TermBlob`]; a ROFL *string* is a [`Value::Str`].
//!
//! Two deliberate deviations, both because the RFDB rule language is not the ROFL rule
//! language:
//!
//! * `$wild` — RFDB has an anonymous term (`_`, `datalog/parser.rs:151`) and ROFL v0 does
//!   not. Round-tripping the 42 shipped rule packs is impossible without it.
//! * perspective and temporal are fixed to `main` / `$now`, because an RFDB rule carries
//!   neither. Decoding REJECTS any other value with a diagnostic rather than dropping it —
//!   perspectives are a separate line of work, and a silent drop would be the exact class
//!   of quiet wrong answer this design forbids.
//!
//! There is no `$builtin` element: an RFDB body element is a positive or negative atom
//! ([`Literal`]) and nothing else; builtins are ordinary atoms dispatched by predicate name
//! (`derive/builtin.rs`).

use std::collections::BTreeMap;

use serde_json::{json, Value as Json};

use crate::datalog::{Atom, Literal, Rule, Term, TermBlob, Value};
use crate::derive::parser_ext::{ExtProgram, Item};
use crate::derive::storage_glue::StorageView;
use crate::storage_v2::types::NodeRecordV2;

// ── Vocabulary ─────────────────────────────────────────────────────

/// The `storage_v2` node type every reflected fact is stored under. Reserved: excluded
/// from every base relation the executor can read (`storage_glue`).
pub const REFLECT_NODE_TYPE: &str = "$rofl/reflect";

/// The virtual file the reflected nodes are attributed to. Never a real path, so no
/// re-analysis of a source file can tombstone a rule.
pub const REFLECT_FILE: &str = "$rofl/rules";

/// Projection T, relation 1 of 3 — the rule ENUMERATOR. `decodeRules` iterates this
/// (`reflect.ts:200`); a rule without it is invisible, however many premises it has.
pub const REL_RULE: &str = "rule";
/// Projection T, relation 2 of 3 — `conclusion_lit(RuleId, 1, ReifiedHead)`.
pub const REL_CONCLUSION_LIT: &str = "conclusion_lit";
/// Projection T, relation 3 of 3 — `premise_lit(RuleId, K, ReifiedBodyElem)`.
pub const REL_PREMISE_LIT: &str = "premise_lit";

/// The only perspective this slice reflects into. RFDB rules carry no perspective.
pub const REFLECT_PERSPECTIVE: &str = "main";
/// The only temporal scope this slice reflects. RFDB rules carry no temporal scope.
pub const REFLECT_TEMPORAL: &str = "$now";

// ── Errors (invariant I5: every rejection carries a stable code) ────

/// A reflection rejection. `code` is the load-bearing field; `detail` is a hint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReflectError {
    /// Stable taxonomy code.
    pub code: &'static str,
    /// One-line human detail.
    pub detail: String,
}

/// A rule term / literal that Projection T cannot encode.
pub const E_REFLECT_ENCODE: &str = "E-REFLECT-001";
/// A stored reflected fact whose shape cannot be decoded back into a rule.
pub const E_REFLECT_DECODE: &str = "E-REFLECT-002";
/// The requested path is unavailable while rules come from the store.
pub const E_REFLECT_MODE: &str = "E-REFLECT-003";

impl ReflectError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        ReflectError { code, detail: detail.into() }
    }

    /// An [`E_REFLECT_MODE`] refusal: the requested path is unavailable while the rules
    /// live in the store. The sanctioned constructor for the mode gate, so every refusal
    /// carries the same code.
    pub fn mode(detail: impl Into<String>) -> Self {
        ReflectError::new(E_REFLECT_MODE, detail)
    }
}

impl std::fmt::Display for ReflectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.code, self.detail)
    }
}

impl std::error::Error for ReflectError {}

// ── A reflected fact ───────────────────────────────────────────────

/// One reflected fact: a predicate name and its positional argument values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReflectedFact {
    /// The relation name (one of [`REL_RULE`], [`REL_CONCLUSION_LIT`], [`REL_PREMISE_LIT`]).
    pub predicate: String,
    /// The positional tuple.
    pub args: Vec<Value>,
}

impl ReflectedFact {
    /// Build a fact.
    pub fn new(predicate: impl Into<String>, args: Vec<Value>) -> Self {
        ReflectedFact { predicate: predicate.into(), args }
    }

    /// Content-addressed identity: BLAKE3 over the canonical bytes of
    /// `<perspective>(<predicate>(arg…))`, truncated to the low 16 bytes (little-endian) —
    /// the same shape as every other node id in this codebase. Writing the same fact twice
    /// therefore hits the same node and never duplicates.
    ///
    /// The PERSPECTIVE is part of the identity, not an afterthought: the reference keys a
    /// fact by `rel[persp](args)` (`vendor/rofl-v0/src/store.ts:25-27`) and the fact model
    /// specifies `fid = BLAKE3(canon(perspective, predicate, tuple))`
    /// (`derive/canon.rs:4`). It is a constant (`main`) in this slice, so nothing collides
    /// today — but leaving it out would make the FIRST second perspective alias two
    /// distinct facts onto one node, and canon-v1 is self-delimiting, so wrapping costs a
    /// functor and buys the property outright.
    pub fn fact_id(&self) -> Result<u128, ReflectError> {
        let term = TermBlob::new(self.predicate.clone(), self.args.clone().into_boxed_slice())
            .map_err(|e| ReflectError::new(E_REFLECT_ENCODE, format!("non-canonical argument: {e}")))?;
        let keyed = TermBlob::new(
            REFLECT_PERSPECTIVE,
            vec![Value::Term(std::sync::Arc::new(term))].into_boxed_slice(),
        )
        .map_err(|e| ReflectError::new(E_REFLECT_ENCODE, format!("non-canonical argument: {e}")))?;
        let mut bytes = Vec::new();
        crate::derive::canon::canon_bytes(&Value::Term(std::sync::Arc::new(keyed)), &mut bytes)
            .map_err(|e| ReflectError::new(E_REFLECT_ENCODE, format!("non-canonical argument: {e}")))?;
        let hash = blake3::hash(&bytes);
        Ok(u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap()))
    }

    /// The reference's `factKey` (`vendor/rofl-v0/src/store.ts:25-27`) for this fact:
    /// `rel[persp](canonTerm(arg),…)`.
    ///
    /// This string is the reference's SCAN ORDER, not a display form. `Store.relAll` walks
    /// a per-relation index kept canonically sorted by this key at all times
    /// (`store.ts:48-59`), so every "last one wins" in `decodeRules` means *lexicographically
    /// greatest fact key*. [`decode_rules`] therefore sorts on this, and not on the
    /// content-addressed node id, which is a hash and orders arbitrarily.
    pub fn fact_key(&self) -> String {
        let args: Vec<String> = self.args.iter().map(canon_value).collect();
        format!("{}[{}]({})", self.predicate, REFLECT_PERSPECTIVE, args.join(","))
    }

    /// The storage node carrying this fact.
    pub fn to_node_record(&self) -> Result<NodeRecordV2, ReflectError> {
        let id = self.fact_id()?;
        Ok(NodeRecordV2 {
            semantic_id: format!("{}#{:032x}", self.predicate, id),
            id,
            node_type: REFLECT_NODE_TYPE.to_string(),
            name: self.predicate.clone(),
            file: REFLECT_FILE.to_string(),
            content_hash: 0,
            metadata: self.to_metadata_json(),
        })
    }

    /// Serialize the tuple into the node metadata blob.
    pub fn to_metadata_json(&self) -> String {
        let args: Vec<Json> = self.args.iter().map(value_to_json).collect();
        json!({ "rofl_reflect": 1, "p": self.predicate, "a": args }).to_string()
    }

    /// Parse a tuple back out of a node metadata blob.
    pub fn from_metadata_json(blob: &str) -> Result<Self, ReflectError> {
        let parsed: Json = serde_json::from_str(blob)
            .map_err(|e| ReflectError::new(E_REFLECT_DECODE, format!("blob is not JSON: {e}")))?;
        let obj = parsed
            .as_object()
            .ok_or_else(|| ReflectError::new(E_REFLECT_DECODE, "blob is not a JSON object"))?;
        if obj.get("rofl_reflect").and_then(Json::as_u64) != Some(1) {
            return Err(ReflectError::new(E_REFLECT_DECODE, "blob is not a v1 reflected fact"));
        }
        let predicate = obj
            .get("p")
            .and_then(Json::as_str)
            .ok_or_else(|| ReflectError::new(E_REFLECT_DECODE, "missing predicate name"))?
            .to_string();
        let args_json = obj
            .get("a")
            .and_then(Json::as_array)
            .ok_or_else(|| ReflectError::new(E_REFLECT_DECODE, "missing argument array"))?;
        let mut args = Vec::with_capacity(args_json.len());
        for a in args_json {
            args.push(value_from_json(a)?);
        }
        Ok(ReflectedFact { predicate, args })
    }
}

// ── Value ⇄ JSON (lossless, because the blob is the storage form) ───

fn value_to_json(v: &Value) -> Json {
    match v {
        Value::Id(x) => json!({ "id": format!("{x:032x}") }),
        Value::Str(s) => json!({ "s": s }),
        // Decimal STRING, not a JSON number: an i64 beyond 2^53 does not survive a JSON
        // number round-trip through a JavaScript reader, and node metadata blobs are
        // readable by clients.
        Value::Int(i) => json!({ "i": i.to_string() }),
        // Bit pattern, so the exact float (canonical per invariant V3) round-trips.
        Value::Float(f) => json!({ "f": format!("{:016x}", f.to_bits()) }),
        Value::BigInt(b) => json!({ "b": hex_encode(b) }),
        Value::Term(t) => {
            let args: Vec<Json> = t.args.iter().map(value_to_json).collect();
            json!({ "t": t.functor, "a": args })
        }
    }
}

fn value_from_json(j: &Json) -> Result<Value, ReflectError> {
    let obj = j
        .as_object()
        .ok_or_else(|| ReflectError::new(E_REFLECT_DECODE, "argument is not a JSON object"))?;
    if let Some(s) = obj.get("s").and_then(Json::as_str) {
        return Ok(Value::Str(s.to_string()));
    }
    if let Some(s) = obj.get("i").and_then(Json::as_str) {
        let i: i64 = s
            .parse()
            .map_err(|_| ReflectError::new(E_REFLECT_DECODE, format!("bad integer '{s}'")))?;
        return Ok(Value::Int(i));
    }
    if let Some(s) = obj.get("id").and_then(Json::as_str) {
        let x = u128::from_str_radix(s, 16)
            .map_err(|_| ReflectError::new(E_REFLECT_DECODE, format!("bad id '{s}'")))?;
        return Ok(Value::Id(x));
    }
    if let Some(s) = obj.get("f").and_then(Json::as_str) {
        let bits = u64::from_str_radix(s, 16)
            .map_err(|_| ReflectError::new(E_REFLECT_DECODE, format!("bad float bits '{s}'")))?;
        return Ok(Value::float(f64::from_bits(bits)));
    }
    if let Some(s) = obj.get("b").and_then(Json::as_str) {
        let bytes = hex_decode(s)
            .ok_or_else(|| ReflectError::new(E_REFLECT_DECODE, format!("bad bigint '{s}'")))?;
        // `big_int_from_be_bytes` is the sanctioned canonicalizing constructor (invariants
        // V1/V2): it strips redundant sign bytes and demotes to `Int` when the value fits
        // i64, so a hand-written blob can never mint a non-canonical `BigInt`.
        return Ok(Value::big_int_from_be_bytes(&bytes));
    }
    if let Some(functor) = obj.get("t").and_then(Json::as_str) {
        let args_json = obj
            .get("a")
            .and_then(Json::as_array)
            .ok_or_else(|| ReflectError::new(E_REFLECT_DECODE, "term without argument array"))?;
        let mut args = Vec::with_capacity(args_json.len());
        for a in args_json {
            args.push(value_from_json(a)?);
        }
        let blob = TermBlob::new(functor, args.into_boxed_slice()).map_err(|e| {
            ReflectError::new(E_REFLECT_DECODE, format!("non-canonical term: {e}"))
        })?;
        return Ok(Value::Term(std::sync::Arc::new(blob)));
    }
    Err(ReflectError::new(E_REFLECT_DECODE, "unrecognized value encoding"))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

// ── Reification: rule AST → reified term ───────────────────────────

/// A ROFL atom (kind `a` in the reference): a zero-arity term.
pub fn rofl_atom(name: &str) -> Value {
    Value::Term(std::sync::Arc::new(TermBlob { functor: name.to_string(), args: Box::new([]) }))
}

fn functor(name: &str, args: Vec<Value>) -> Result<Value, ReflectError> {
    let blob = TermBlob::new(name, args.into_boxed_slice())
        .map_err(|e| ReflectError::new(E_REFLECT_ENCODE, format!("non-canonical argument: {e}")))?;
    Ok(Value::Term(std::sync::Arc::new(blob)))
}

/// `$cons`/`$nil` list, right-folded exactly like the reference's `list()`
/// (`reflect.ts:50-54`).
fn reify_list(items: Vec<Value>) -> Result<Value, ReflectError> {
    let mut acc = rofl_atom("$nil");
    for item in items.into_iter().rev() {
        acc = functor("$cons", vec![item, acc])?;
    }
    Ok(acc)
}

fn unreify_list(v: &Value) -> Result<Vec<Value>, ReflectError> {
    let mut out = Vec::new();
    let mut cur = v.clone();
    loop {
        match &cur {
            Value::Term(t) if t.functor == "$nil" && t.args.is_empty() => return Ok(out),
            Value::Term(t) if t.functor == "$cons" && t.args.len() == 2 => {
                out.push(t.args[0].clone());
                cur = t.args[1].clone();
            }
            _ => {
                return Err(ReflectError::new(E_REFLECT_DECODE, "argument list is not $cons/$nil"))
            }
        }
    }
}

/// Reify one rule term.
pub fn reify_term(t: &Term) -> Result<Value, ReflectError> {
    match t {
        Term::Var(name) => functor("$var", vec![Value::Str(name.clone())]),
        Term::Wildcard => Ok(rofl_atom("$wild")),
        Term::Const(s) => Ok(Value::Str(s.clone())),
        Term::Lit(v) => match v {
            // A string / term literal would be indistinguishable from `Const` / a reified
            // structure on the way back. The RFDB grammar cannot produce either
            // (`datalog/parser.rs:146-176` yields `Const` for strings and Int/Float/BigInt
            // for numbers), so this is a hard refusal, not a lossy fallback.
            Value::Str(_) | Value::Term(_) => Err(ReflectError::new(
                E_REFLECT_ENCODE,
                "a Lit term holding a string or a term is not representable in Projection T",
            )),
            other => Ok(other.clone()),
        },
    }
}

/// Recover one rule term from its reified form.
pub fn unreify_term(v: &Value) -> Result<Term, ReflectError> {
    match v {
        Value::Str(s) => Ok(Term::Const(s.clone())),
        Value::Term(t) if t.functor == "$var" && t.args.len() == 1 => match &t.args[0] {
            Value::Str(name) => Ok(Term::Var(name.clone())),
            _ => Err(ReflectError::new(E_REFLECT_DECODE, "$var argument is not a string")),
        },
        Value::Term(t) if t.functor == "$wild" && t.args.is_empty() => Ok(Term::Wildcard),
        Value::Term(t) => Err(ReflectError::new(
            E_REFLECT_DECODE,
            format!("unsupported reified term '{}'/{}", t.functor, t.args.len()),
        )),
        other => Ok(Term::Lit(other.clone())),
    }
}

/// Reify an atom into the reference's `$lit(rel, persp, args, temporal)`.
pub fn reify_atom(a: &Atom) -> Result<Value, ReflectError> {
    let args: Result<Vec<Value>, ReflectError> = a.args().iter().map(reify_term).collect();
    functor(
        "$lit",
        vec![
            rofl_atom(a.predicate()),
            rofl_atom(REFLECT_PERSPECTIVE),
            reify_list(args?)?,
            rofl_atom(REFLECT_TEMPORAL),
        ],
    )
}

/// Recover an atom from a `$lit(...)` term.
pub fn unreify_atom(v: &Value) -> Result<Atom, ReflectError> {
    let t = match v {
        Value::Term(t) if t.functor == "$lit" && t.args.len() == 4 => t,
        _ => return Err(ReflectError::new(E_REFLECT_DECODE, "not a 4-argument $lit term")),
    };
    let rel = match &t.args[0] {
        Value::Term(a) if a.args.is_empty() => a.functor.clone(),
        _ => return Err(ReflectError::new(E_REFLECT_DECODE, "$lit relation is not an atom")),
    };
    match &t.args[1] {
        Value::Term(p) if p.args.is_empty() && p.functor == REFLECT_PERSPECTIVE => {}
        _ => {
            return Err(ReflectError::new(
                E_REFLECT_DECODE,
                format!("perspective other than '{REFLECT_PERSPECTIVE}' is not supported yet"),
            ))
        }
    }
    match &t.args[3] {
        Value::Term(s) if s.args.is_empty() && s.functor == REFLECT_TEMPORAL => {}
        _ => {
            return Err(ReflectError::new(
                E_REFLECT_DECODE,
                format!("temporal scope other than '{REFLECT_TEMPORAL}' is not supported yet"),
            ))
        }
    }
    let args: Result<Vec<Term>, ReflectError> =
        unreify_list(&t.args[2])?.iter().map(unreify_term).collect();
    Ok(Atom::new(&rel, args?))
}

/// Reify a body element: positive → `$lit(…)`, negative → `$not($lit(…))`.
pub fn reify_body_elem(l: &Literal) -> Result<Value, ReflectError> {
    match l {
        Literal::Positive(a) => reify_atom(a),
        Literal::Negative(a) => functor("$not", vec![reify_atom(a)?]),
    }
}

/// Recover a body element.
pub fn unreify_body_elem(v: &Value) -> Result<Literal, ReflectError> {
    if let Value::Term(t) = v {
        if t.functor == "$not" && t.args.len() == 1 {
            return Ok(Literal::Negative(unreify_atom(&t.args[0])?));
        }
    }
    Ok(Literal::Positive(unreify_atom(v)?))
}

// ── Canonical clause text and the surface rule id ──────────────────

/// 32-bit FNV-1a over UTF-16 code units — byte-for-byte the reference's `fnv1a`
/// (`vendor/rofl-v0/src/unify.ts:118-125`, which folds `charCodeAt`).
pub fn fnv1a(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for unit in s.encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// Canonical text of a rule term — the reference's `canonTerm`
/// (`unify.ts:79-87`) over the RFDB term set. `_` is RFDB-only (ROFL v0 has no wildcard).
pub fn canon_term(t: &Term) -> String {
    match t {
        Term::Var(name) => format!("?{name}"),
        Term::Const(s) => Json::String(s.clone()).to_string(),
        Term::Wildcard => "_".to_string(),
        Term::Lit(v) => match v {
            Value::Int(i) => i.to_string(),
            Value::Float(f) => format!("{f}"),
            Value::BigInt(_) | Value::Id(_) | Value::Str(_) | Value::Term(_) => {
                crate::datalog::value_to_wire_string(v)
            }
        },
    }
}

/// Canonical text of a REIFIED value — the reference's `canonTerm` (`unify.ts:79-87`) over
/// the value alphabet a reflected fact's arguments live in.
///
/// The mapping onto the reference's five term kinds is exact: `Str` is its `'s'`
/// (JSON-quoted), `Int` its `'i'`, a zero-arity `Term` its `'a'` (a bare atom name), an
/// n-ary `Term` its `'f'`. `Float`/`BigInt`/`Id` have no reference counterpart — they come
/// from RFDB's wider literal set — and go through the ONE value-to-text codec
/// ([`crate::datalog::value_to_wire_string`]), exactly as [`canon_term`] renders them.
///
/// This is a different function from [`canon_term`] and deliberately so: that one is the
/// canonical text of a rule TERM (`?X` for a variable), this one of a stored fact
/// ARGUMENT, where a variable has already been reified into the ordinary term `$var("X")`.
pub fn canon_value(v: &Value) -> String {
    match v {
        Value::Str(s) => Json::String(s.clone()).to_string(),
        Value::Int(i) => i.to_string(),
        Value::Term(t) if t.args.is_empty() => t.functor.clone(),
        Value::Term(t) => {
            let args: Vec<String> = t.args.iter().map(canon_value).collect();
            format!("{}({})", t.functor, args.join(","))
        }
        Value::Float(_) | Value::BigInt(_) | Value::Id(_) => {
            crate::datalog::value_to_wire_string(v)
        }
    }
}

/// Canonical text of a literal — the reference's `canonLit` (`reflect.ts:114-116`).
pub fn canon_atom(a: &Atom) -> String {
    let args: Vec<String> = a.args().iter().map(canon_term).collect();
    format!(
        "{}[{}]({})@{}",
        a.predicate(),
        REFLECT_PERSPECTIVE,
        args.join(","),
        &REFLECT_TEMPORAL[1..]
    )
}

/// Canonical text of a body element — the reference's `canonBodyElem` (`reflect.ts:118-122`).
pub fn canon_body_elem(l: &Literal) -> String {
    match l {
        Literal::Positive(a) => canon_atom(a),
        Literal::Negative(a) => format!("not {}", canon_atom(a)),
    }
}

/// Canonical text of a clause — the reference's `canonClause` (`reflect.ts:124-127`).
/// It is both the rule-identity input and the total order `decode_rules` sorts by.
pub fn canon_clause(r: &Rule) -> String {
    if r.body().is_empty() {
        canon_atom(r.head())
    } else {
        let body: Vec<String> = r.body().iter().map(canon_body_elem).collect();
        format!("{} :- {}", canon_atom(r.head()), body.join(", "))
    }
}

/// The surface rule id — the reference's `ruleIdOf` (`reflect.ts:129-131`): `r` + FNV-1a of
/// the canonical clause. Content-addressed: two textually different spellings of the same
/// clause reflect onto the same rule.
///
/// This is a DIFFERENT identity from `materialize::rule_ast_hash` (the `@materialize`
/// provenance stamp) and neither replaces the other — they answer different questions and
/// coexist deliberately.
pub fn rule_id(r: &Rule) -> String {
    format!("r{}", fnv1a(&canon_clause(r)))
}

// ── Encoding ───────────────────────────────────────────────────────

/// Encode one rule into Projection T: `rule(Id)`, `conclusion_lit(Id, 1, Head)` and one
/// `premise_lit(Id, K, Elem)` per body element, `K` counted from 1 (the reference's
/// `encodeRule`, `reflect.ts:149-177`, minus the audit-only relations).
pub fn encode_rule(r: &Rule) -> Result<(String, Vec<ReflectedFact>), ReflectError> {
    let id = rule_id(r);
    let rid = rofl_atom(&id);
    let mut facts = vec![
        ReflectedFact::new(REL_RULE, vec![rid.clone()]),
        ReflectedFact::new(
            REL_CONCLUSION_LIT,
            vec![rid.clone(), Value::Int(1), reify_atom(r.head())?],
        ),
    ];
    for (i, elem) in r.body().iter().enumerate() {
        facts.push(ReflectedFact::new(
            REL_PREMISE_LIT,
            vec![rid.clone(), Value::Int(i as i64 + 1), reify_body_elem(elem)?],
        ));
    }
    Ok((id, facts))
}

/// Encode a whole program's rules into the storage records that carry them. Duplicate
/// facts across rules (two clauses of one predicate share nothing, but two identical
/// clauses share everything) collapse by node id, which is the intended idempotence.
///
/// Equivalent to [`encode_rules_to_records_beside`] against an empty store.
pub fn encode_rules_to_records(rules: &[&Rule]) -> Result<Vec<NodeRecordV2>, ReflectError> {
    encode_rules_to_records_beside(rules, &BTreeMap::new())
}

/// [`encode_rules_to_records`] against a store that ALREADY holds reflected rules
/// (`already`: enumerated rule id → canonical clause, from [`rule_index`]).
///
/// # Why the gate exists
///
/// The rule id is the reference's ([`rule_id`]): `r` + a 32-BIT FNV-1a of the canonical
/// clause. Thirty-two bits is a birthday bound, not a guarantee, and reflection is
/// ADDITIVE — the premises of two clauses landing on one id would merge into a rule that
/// was never written, silently, because `decode_rules` assembles a rule out of every fact
/// carrying its id. So the collision is caught HERE, at the only door that can still
/// refuse: writing two different clauses under one id is `E-REFLECT-001`.
///
/// The gate belongs on the write side and nowhere else. Re-deriving the id from a DECODED
/// rule and rejecting a mismatch would also catch it, and would destroy the decoder's four
/// documented outcomes on an incomplete reflection (a rule missing premises decodes to a
/// shorter clause with a different id — the reference runs it, and `p3-malformed-sibling`
/// stands on exactly that).
pub fn encode_rules_to_records_beside(
    rules: &[&Rule],
    already: &BTreeMap<String, String>,
) -> Result<Vec<NodeRecordV2>, ReflectError> {
    let mut canon_by_rule_id: BTreeMap<String, String> = already.clone();
    let mut by_id: BTreeMap<u128, NodeRecordV2> = BTreeMap::new();
    for r in rules {
        let (id, facts) = encode_rule(r)?;
        let canon = canon_clause(r);
        if let Some(prev) = canon_by_rule_id.insert(id.clone(), canon.clone()) {
            if prev != canon {
                return Err(ReflectError::new(
                    E_REFLECT_ENCODE,
                    format!(
                        "rule id {id} collides: '{prev}' and '{canon}' hash alike, and \
                         reflection is additive — their premises would merge into a rule \
                         nobody wrote"
                    ),
                ));
            }
        }
        for f in facts {
            let rec = f.to_node_record()?;
            by_id.insert(rec.id, rec);
        }
    }
    Ok(by_id.into_values().collect())
}

/// The rules a store already holds, as enumerated rule id → canonical clause — the
/// `already` argument of [`encode_rules_to_records_beside`].
///
/// Built from [`decode_rules`], so a reflection the decoder skips is absent here: there is
/// no clause to collide with.
pub fn rule_index(view: &dyn StorageView) -> BTreeMap<String, String> {
    let decoded = decode_rules(view);
    decoded
        .ids
        .iter()
        .zip(decoded.rules.iter())
        .map(|(id, r)| (id.clone(), canon_clause(r)))
        .collect()
}

/// Refuse a program Projection T cannot carry whole.
///
/// Projection T reflects RULES — `rule/1`, `conclusion_lit/3`, `premise_lit/3` — and
/// nothing else. A program also carries `#requires` pragmas, `@materialize` /
/// `@materialize_node` annotations and lattice payloads, and none of them survive the round
/// trip. Dropping them is NOT cosmetic: annotations feed the stratifier
/// (`derive/stratify.rs:205-233` — a materialized edge/node type is a cross-run producer
/// and gets a dependency edge), so the same program could land in a different stratum
/// order in store mode than in text mode, and with negation that changes the ANSWER.
///
/// Refusing at the write door is what makes the read door safe: a store assembled through
/// [`crate::graph::engine_v2::GraphEngineV2::reflect_program`] can only ever hold programs
/// for which "no annotations" is the truth rather than an omission.
pub fn refuse_unreflectable_program(program: &ExtProgram) -> Result<(), ReflectError> {
    if !program.requires.is_empty() {
        return Err(ReflectError::mode(
            "a program with `#requires` pragmas cannot be reflected: Projection T carries \
             rules only, and the pragma would be lost without trace",
        ));
    }
    for item in &program.items {
        if !item.annotations.is_empty() {
            return Err(ReflectError::mode(
                "a program with annotations (`@materialize` / `@materialize_node`) cannot \
                 be reflected: Projection T carries rules only, and the annotation feeds \
                 stratification — losing it can change the answer, not just the write-back",
            ));
        }
        if item.lattice_payload.is_some() {
            return Err(ReflectError::mode(
                "a rule with a lattice payload cannot be reflected: Projection T carries \
                 the clause only",
            ));
        }
    }
    Ok(())
}

// ── Decoding — the executor's ONLY rule source ─────────────────────

/// The result of assembling rules out of the store.
#[derive(Debug, Clone, Default)]
pub struct DecodedRules {
    /// Executable rules, sorted by [`canon_clause`] so the order never depends on the
    /// order facts happen to sit in storage (the reference sorts identically,
    /// `reflect.ts:214`).
    pub rules: Vec<Rule>,
    /// The ENUMERATED rule id (the `rule/1` argument) each decoded rule was assembled
    /// under, positionally parallel to [`Self::rules`] — the reference's `DRule.id`
    /// (`reflect.ts:183`).
    ///
    /// It is NOT necessarily `rule_id(&rules[i])`: an incompletely reflected rule decodes
    /// to a clause the id no longer names, which is the reference's behaviour and the
    /// substrate of `p3-malformed-sibling`. The write-side collision gate
    /// ([`encode_rules_to_records_beside`]) reads it for exactly that reason — it needs
    /// what the store CLAIMS, not what the clause recomputes to.
    pub ids: Vec<String>,
    /// Per-rule diagnostics for reflections that were skipped.
    pub diagnostics: Vec<String>,
}

/// Assemble the executable rule set from the reflected store — the literal mirror of
/// `decodeRules` (`vendor/rofl-v0/src/reflect.ts:185-216`).
///
/// The four outcomes of an INCOMPLETE reflection are the reference's, reproduced on
/// purpose (they are the substrate of the `p3-malformed-sibling` scenario, where a rule the
/// audit calls malformed keeps executing):
///
/// | what is missing | what happens |
/// |---|---|
/// | the `rule/1` fact | the rule is invisible; no diagnostic (the enumerator runs over it) |
/// | `conclusion_lit` | skipped WITH a diagnostic |
/// | every `premise_lit` | the rule silently becomes an unconditional fact |
/// | some `premise_lit` | a shorter body executes, no diagnostic |
///
/// A reflection whose terms do not decode is skipped with a diagnostic.
///
/// Two facts claiming the same `conclusion_lit` slot: the last one in the scan wins, as in
/// the reference — and "last" means the same thing here as there. The reference's
/// `relAll` walks a per-relation index held canonically sorted by
/// `factKey = rel[persp](canonTerm(args))` (`store.ts:48-59`), so the scan below sorts on
/// [`ReflectedFact::fact_key`]. Sorting on the content-addressed node id instead would be
/// deterministic but ARBITRARY, and would pick a different winner from the reference on a
/// contested slot.
pub fn decode_rules(view: &dyn StorageView) -> DecodedRules {
    let mut diagnostics: Vec<String> = Vec::new();
    let mut raw: Vec<(String, ReflectedFact)> = Vec::new();
    for (id, blob) in view.reflected_facts() {
        match ReflectedFact::from_metadata_json(&blob) {
            Ok(f) => raw.push((f.fact_key(), f)),
            Err(e) => diagnostics.push(format!("reflected fact {id:032x}: {e}; skipped")),
        }
    }
    raw.sort_by(|a, b| a.0.cmp(&b.0));

    let mut conclusions: BTreeMap<String, Value> = BTreeMap::new();
    let mut premises: BTreeMap<String, Vec<(i64, Value)>> = BTreeMap::new();
    let mut enumerated: Vec<String> = Vec::new();

    for (_, f) in &raw {
        match f.predicate.as_str() {
            REL_RULE => {
                if f.args.len() == 1 {
                    if let Some(id) = as_rule_id(&f.args[0]) {
                        enumerated.push(id);
                    }
                }
            }
            REL_CONCLUSION_LIT => {
                if f.args.len() == 3 {
                    if let Some(id) = as_rule_id(&f.args[0]) {
                        conclusions.insert(id, f.args[2].clone());
                    }
                }
            }
            REL_PREMISE_LIT => {
                if f.args.len() == 3 {
                    if let (Some(id), Value::Int(k)) = (as_rule_id(&f.args[0]), &f.args[1]) {
                        premises.entry(id).or_default().push((*k, f.args[2].clone()));
                    }
                }
            }
            // A reflected fact in a relation Projection T does not consult (an audit
            // relation, say) is not an error — it simply is not a rule source.
            _ => {}
        }
    }

    enumerated.sort();
    enumerated.dedup();

    // (canonical clause, enumerated rule id, rule) — the canon leads because it is the
    // reference's sort key (`reflect.ts:214`); the id rides along for the write-side gate.
    let mut rules: Vec<(String, String, Rule)> = Vec::new();
    for id in enumerated {
        let Some(head_term) = conclusions.get(&id) else {
            diagnostics.push(format!("rule {id}: missing conclusion reflection; skipped"));
            continue;
        };
        let head = match unreify_atom(head_term) {
            Ok(h) => h,
            Err(e) => {
                diagnostics.push(format!("rule {id}: undecodable reflection ({e}); skipped"));
                continue;
            }
        };
        let mut body_terms = premises.get(&id).cloned().unwrap_or_default();
        // The premise ORDER is recovered by sorting on the numeric key, exactly as the
        // reference does (`reflect.ts:207`). Holes in the numbering collapse.
        body_terms.sort_by_key(|(k, _)| *k);
        let mut body = Vec::with_capacity(body_terms.len());
        let mut failed = None;
        for (_, t) in body_terms {
            match unreify_body_elem(&t) {
                Ok(l) => body.push(l),
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        if let Some(e) = failed {
            diagnostics.push(format!("rule {id}: undecodable reflection ({e}); skipped"));
            continue;
        }
        let rule = Rule::new(head, body);
        rules.push((canon_clause(&rule), id, rule));
    }
    rules.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out_rules = Vec::with_capacity(rules.len());
    let mut out_ids = Vec::with_capacity(rules.len());
    for (_, id, rule) in rules {
        out_rules.push(rule);
        out_ids.push(id);
    }
    DecodedRules { rules: out_rules, ids: out_ids, diagnostics }
}

fn as_rule_id(v: &Value) -> Option<String> {
    match v {
        Value::Term(t) if t.args.is_empty() => Some(t.functor.clone()),
        _ => None,
    }
}

/// The store-mode twin of [`crate::derive::parser_ext::parse_ext_program`]: the program the
/// evaluator runs, assembled from facts instead of text.
///
/// Carries no `#requires` pragmas and no annotations — Projection T does not encode them
/// (neither does the reference). Every path that NEEDS an annotation (the `@materialize`
/// write-back) refuses in store mode with [`E_REFLECT_MODE`] rather than silently writing
/// nothing.
pub fn program_from_store(view: &dyn StorageView) -> DecodedProgram {
    let decoded = decode_rules(view);
    let program = ExtProgram {
        requires: Vec::new(),
        items: decoded
            .rules
            .into_iter()
            .map(|rule| Item { annotations: Vec::new(), rule, lattice_payload: None })
            .collect(),
    };
    DecodedProgram { program, diagnostics: decoded.diagnostics }
}

/// A program assembled from the store, plus the reflections that were skipped getting there.
#[derive(Debug, Clone)]
pub struct DecodedProgram {
    /// The executable program.
    pub program: ExtProgram,
    /// Skipped-reflection diagnostics (never silent).
    pub diagnostics: Vec<String>,
}

#[cfg(test)]
mod tests;
