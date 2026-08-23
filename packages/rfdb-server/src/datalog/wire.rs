//! The wire codec for datalog [`Value`]s — the single place where a value crosses the
//! rfdb-server protocol boundary as text, in BOTH directions.
//!
//! The server's typed value domain has six variants (`Id`, `Str`, `Int`, `Float`, `BigInt`,
//! `Term`; see [`Value`]) while the protocol carries plain strings (`WireBodyFact.tuple`,
//! the `key` array of `explainDatalogFact` / `explainDatalogGap`). A codec that renders more
//! variants than it parses loses type information the engine already has, so the same logical
//! value can re-enter as a different variant on a different path. This module is the total,
//! injective encoding that closes that hole:
//!
//! > **`wire_string_to_value(value_to_wire_string(v)) == v` for every canonical `v`** whose
//! > term nesting is within [`MAX_TERM_DEPTH`].
//!
//! The depth side-condition is not a hedge, it is the safety cap below: past it the parse
//! direction refuses the tagged reading rather than recursing, so a term nested deeper than
//! [`MAX_TERM_DEPTH`] would render tagged and read back as a `Str`. No production producer
//! reaches that depth — the engine's own term producers are `facts::convert` (one level) and
//! the segment/sidecar decoders, which re-read what this parser already accepted — but the
//! property is stated with its bound rather than without it.
//!
//! # Grammar
//!
//! ```text
//! wire     := tagged | untagged
//!
//! tagged   := "~id:"    DEC_U128            -- Value::Id
//!           | "~int:"   DEC_I64             -- Value::Int
//!           | "~float:" FLOAT               -- Value::Float  (Rust f64 Display/FromStr)
//!           | "~big:"   DEC_INT             -- Value::BigInt (exact decimal, any width)
//!           | "~str:"   QUOTED              -- Value::Str
//!           | "~term:"  QUOTED [ "(" tagged { "," tagged } ")" ]   -- Value::Term
//!
//! untagged := DEC_U128                      -- Value::Id   (legacy reading)
//!           | <any other text, verbatim>    -- Value::Str  (legacy reading)
//!
//! QUOTED   := '"' { '\\' ('"' | '\\') | <char other than '"' and '\\'> } '"'
//! ```
//!
//! # The decimal ambiguity, resolved
//!
//! A bare decimal string could plausibly be an `Id`, an `Int`, a `BigInt` or a `Str`. The rule,
//! chosen deliberately and mirrored exactly by both directions:
//!
//! 1. **A bare decimal is always a node `Id`.** Node ids dominate the wire (`explain_fact`'s
//!    `key` is documented as a list of node ids), and this is the pre-existing reading — keeping
//!    it is what makes the parser backward compatible with every untagged client.
//! 2. **Every other variant is tagged.** `Int`, `Float`, `BigInt` and `Term` therefore never
//!    contend for the bare-decimal (or bare-text) form.
//! 3. **A `Str` is rendered verbatim only when that is faithful** — i.e. exactly when parsing
//!    it back yields the same `Str`. A `Str` that would be re-read as something else (it parses
//!    as `u128`, or it happens to spell a complete tagged form) is rendered as `~str:"…"`.
//!    [`is_self_representing`] IS that predicate, so the escape fires if and only if it is
//!    needed and the common case (paths, names, edge types) stays byte-identical to the
//!    pre-codec wire.
//! 4. **Inside a term, every argument is tagged** — a term's argument list has no bare form at
//!    all, so nesting introduces no new ambiguity and the recursion is decidable. It is also
//!    BOUNDED, at [`MAX_TERM_DEPTH`]: the parse direction reads untrusted wire input, where
//!    unbounded recursion is a process-killing stack overflow, not a parse error.
//!
//! # Backward compatibility, stated exactly
//!
//! Anything that is not a *complete* tagged form falls through to the legacy reading, so the
//! parser accepts every string the two-arm one accepted. That superset is **syntactic, not
//! semantic**, and the difference is worth stating precisely rather than as "nothing breaks":
//!
//! * **Render direction — no break.** [`is_self_representing`] is exactly the predicate "the
//!   verbatim form reads back as this same `Str`", so a value the server emits can never
//!   collide with a tag; node ids and ordinary names (paths, semantic ids, edge types) stay
//!   byte-identical to the pre-codec wire.
//! * **Parse direction — one bounded break.** Key text that spells a COMPLETE tagged form
//!   changes meaning: a client that sends the literal `~int:5` (or `~term:"f"`, or
//!   `~big:295147905179352825856`) used to get `Str("~int:5")` and now gets `Int(5)`. Keys in
//!   practice are node ids and semantic ids, so this set is not reachable from any observed
//!   client — but it IS a change, pinned by
//!   [`tests::text_that_spells_a_complete_tagged_form_changes_its_reading`], not a claim that
//!   no input at all moves. Everything else keeps the legacy reading — including a tagged
//!   PREFIX with trailing junk (`~int:5x`, `~int:5,x`) and nesting past [`MAX_TERM_DEPTH`].
//!
//! # Canonicality
//!
//! The parser builds values through the canonicalizing constructors ([`Value::float`],
//! [`Value::big_int_from_decimal`]), so the wire can never inject a value that violates the
//! §2.5 invariants V1–V4 into the engine. Consequently the round-trip is the *identity* on the
//! canonical value domain and *canonicalizing* on non-canonical input (`BigInt` holding an
//! i64-range value → `Int`; `Float(-0.0)` → `Float(0.0)`) — which is the intended behaviour,
//! not a gap: non-canonical values are rejected at the canonical boundaries anyway
//! (`E-VAL-001`/`E-VAL-002`).

use std::sync::Arc;

use super::eval::{big_int_to_decimal, TermBlob, Value};

/// `Value::Id` tag — emitted inside terms; at top level an `Id` uses the bare decimal form.
const TAG_ID: &str = "~id:";
/// `Value::Int` tag.
const TAG_INT: &str = "~int:";
/// `Value::Float` tag.
const TAG_FLOAT: &str = "~float:";
/// `Value::BigInt` tag; payload is the exact decimal, never a JS-unsafe number.
const TAG_BIGINT: &str = "~big:";
/// `Value::Str` tag; payload is a quoted string. Only emitted when the verbatim form
/// would be re-read as another variant.
const TAG_STR: &str = "~str:";
/// `Value::Term` tag; payload is a quoted functor plus an optional tagged argument list.
const TAG_TERM: &str = "~term:";

/// Every tagged form starts with this sigil — the parser's fast reject.
const SIGIL: char = '~';

/// Hard cap on the term nesting the parser will accept — a SAFETY limit, not a tuning knob.
///
/// The parse direction is fed straight from unauthenticated wire input (`read_message` accepts
/// frames up to 100 MiB) and is recursive-descent, so every `~term:…(` in the input costs one
/// stack frame. In Rust a stack overflow is not an unwind but an immediate `SIGABRT`: it kills
/// the whole server process — every connection and every database — and cannot be caught. Past
/// this depth the parser therefore REFUSES the tagged reading (the input falls through to the
/// legacy `Str`, which is exactly how every other malformed tagged form is treated) instead of
/// recursing. 64 mirrors [`crate::datalog::EvalLimits`]'s own `max_derived_depth` and is far
/// above anything the engine builds: the only other production term producers are
/// `facts::convert` (`$json`/`$null`, one level) and the segment/sidecar decoders, which
/// re-read values that entered through this very parser.
const MAX_TERM_DEPTH: u32 = 64;

/// Render a datalog [`Value`] to its wire string. The exact inverse of
/// [`wire_string_to_value`]: `wire_string_to_value(value_to_wire_string(v)) == v` for every
/// canonical `v`, over all six variants.
///
/// Backward compatible by construction: a node `Id` renders as the bare decimal it always did,
/// and a `Str` renders verbatim unless that exact text would be re-read as a different value
/// (see the module-level "decimal ambiguity" rule). `Int`, `Float`, `BigInt` and `Term` — the
/// variants the pre-codec parser could not read back at all — render tagged.
pub fn value_to_wire_string(v: &Value) -> String {
    match v {
        // The bare decimal form: what every existing client already sends and reads.
        Value::Id(id) => id.to_string(),
        // Verbatim only when the untagged reading is faithful (rule 3).
        Value::Str(s) if is_self_representing(s) => s.clone(),
        other => {
            let mut out = String::new();
            push_tagged(other, &mut out);
            out
        }
    }
}

/// Parse a wire string into a datalog [`Value`]. Total (never fails): a complete tagged form
/// decodes to its variant; anything else takes the legacy reading — an all-digit string is a
/// node id ([`Value::Id`]), everything else is a string literal ([`Value::Str`]).
///
/// The exact inverse of [`value_to_wire_string`] on that function's output. It ACCEPTS every
/// string the two-arm reading accepted, but that superset is syntactic, not semantic: text
/// that spells a complete tagged form now reads as its tag rather than as a plain `Str` (see
/// the module docs, "Backward compatibility, stated exactly", for the full statement of the
/// one break, the grammar, and why a bare decimal stays an `Id`). Term nesting past
/// [`MAX_TERM_DEPTH`] is refused — the input keeps the legacy reading — because this direction
/// parses untrusted wire input.
pub fn wire_string_to_value(s: &str) -> Value {
    if let Some(v) = parse_tagged_complete(s) {
        return v;
    }
    match s.parse::<u128>() {
        Ok(id) => Value::Id(id),
        Err(_) => Value::Str(s.to_string()),
    }
}

/// Whether a string renders verbatim without changing meaning — precisely
/// `wire_string_to_value(s) == Value::Str(s)`, stated without building the value.
fn is_self_representing(s: &str) -> bool {
    s.parse::<u128>().is_err() && parse_tagged_complete(s).is_none()
}

/// Parse `s` as a tagged form that consumes the WHOLE input. Trailing junk (`~int:5x`) is not
/// a tagged value and falls through to the legacy reading — the renderer never emits it.
fn parse_tagged_complete(s: &str) -> Option<Value> {
    if !s.starts_with(SIGIL) {
        return None;
    }
    let mut p = WireParser { s, pos: 0 };
    let v = p.parse_tagged(0)?;
    if p.pos == s.len() {
        Some(v)
    } else {
        None
    }
}

// ── Rendering ──

/// Append the always-tagged form of `v`. Used for every variant at top level except the two
/// backward-compatible bare forms, and for EVERY argument inside a term.
fn push_tagged(v: &Value, out: &mut String) {
    match v {
        Value::Id(id) => {
            out.push_str(TAG_ID);
            out.push_str(&id.to_string());
        }
        Value::Int(i) => {
            out.push_str(TAG_INT);
            out.push_str(&i.to_string());
        }
        Value::Float(f) => {
            out.push_str(TAG_FLOAT);
            // Rust's f64 Display is the shortest text that parses back to the same bits, and
            // covers inf/-inf/NaN — so FromStr recovers the value exactly.
            out.push_str(&f.to_string());
        }
        Value::BigInt(b) => {
            out.push_str(TAG_BIGINT);
            out.push_str(&big_int_to_decimal(b));
        }
        Value::Str(s) => {
            out.push_str(TAG_STR);
            push_quoted(s, out);
        }
        Value::Term(t) => {
            out.push_str(TAG_TERM);
            // The functor is quoted too: functors may contain `(`, `,` or `"`.
            push_quoted(&t.functor, out);
            if !t.args.is_empty() {
                out.push('(');
                for (i, arg) in t.args.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    push_tagged(arg, out);
                }
                out.push(')');
            }
        }
    }
}

/// Append `s` as a QUOTED payload: `"` … `"` with `\` and `"` backslash-escaped, so the payload
/// is self-delimiting even when it contains the term separators `,` and `)`.
fn push_quoted(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
}

// ── Parsing ──

/// Recursive-descent cursor over a wire string. `pos` is a byte offset and only ever advances
/// past whole characters (the delimiters `"`, `\`, `(`, `)`, `,` and the tags are all ASCII).
struct WireParser<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> WireParser<'a> {
    fn rest(&self) -> &'a str {
        &self.s[self.pos..]
    }

    /// Consume `lit` if it is next; report whether it was.
    fn eat(&mut self, lit: &str) -> bool {
        if self.rest().starts_with(lit) {
            self.pos += lit.len();
            true
        } else {
            false
        }
    }

    /// Consume a scalar payload: everything up to the next `,` or `)` (or end of input).
    /// Decimal and `f64`-Display payloads never contain either character, so this is exact.
    fn take_scalar(&mut self) -> &'a str {
        let rest = self.rest();
        let end = rest.find([',', ')']).unwrap_or(rest.len());
        self.pos += end;
        &rest[..end]
    }

    /// Consume a QUOTED payload, undoing the `\` escapes. `None` if the payload is not a
    /// well-formed quoted string (missing open/close quote, or an escape of anything other
    /// than `"`/`\`) — the renderer never produces those.
    fn parse_quoted(&mut self) -> Option<String> {
        let rest = self.rest();
        let mut chars = rest.char_indices();
        if chars.next()?.1 != '"' {
            return None;
        }
        let mut out = String::new();
        let mut escaped = false;
        for (i, c) in chars {
            if escaped {
                if c != '"' && c != '\\' {
                    return None;
                }
                out.push(c);
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                self.pos += i + 1; // `"` is one byte
                return Some(out);
            } else {
                out.push(c);
            }
        }
        None
    }

    /// Parse one tagged value at the cursor. `None` when the cursor is not on a well-formed
    /// tagged form; the caller decides whether that is a legacy string (top level) or a
    /// malformed term (inside an argument list).
    ///
    /// `depth` is the number of enclosing term argument lists — 0 at top level. It is a
    /// PARAMETER, not parser state, so an early `?` return can never leave a counter stale;
    /// past [`MAX_TERM_DEPTH`] a term is refused rather than recursed into.
    fn parse_tagged(&mut self, depth: u32) -> Option<Value> {
        if self.eat(TAG_ID) {
            return self.take_scalar().parse::<u128>().ok().map(Value::Id);
        }
        if self.eat(TAG_INT) {
            return self.take_scalar().parse::<i64>().ok().map(Value::Int);
        }
        if self.eat(TAG_FLOAT) {
            // `Value::float`, not the raw constructor: the wire must not be able to inject a
            // non-canonical float (V3) into the engine.
            return self.take_scalar().parse::<f64>().ok().map(Value::float);
        }
        if self.eat(TAG_BIGINT) {
            // Canonicalizing (V1/V2): an i64-range decimal comes back as `Int`, as it must.
            return Value::big_int_from_decimal(self.take_scalar());
        }
        if self.eat(TAG_STR) {
            return self.parse_quoted().map(Value::Str);
        }
        if self.eat(TAG_TERM) {
            let functor = self.parse_quoted()?;
            let mut args: Vec<Value> = Vec::new();
            if self.eat("(") {
                // Untrusted input: one stack frame per nesting level, and a Rust stack
                // overflow aborts the process (see MAX_TERM_DEPTH). Refuse, don't recurse.
                if depth >= MAX_TERM_DEPTH {
                    return None;
                }
                // Arity 0 renders WITHOUT parens, so an empty `()` is not in the language.
                loop {
                    args.push(self.parse_tagged(depth + 1)?);
                    if self.eat(",") {
                        continue;
                    }
                    if self.eat(")") {
                        break;
                    }
                    return None;
                }
            }
            return Some(Value::Term(Arc::new(TermBlob {
                functor,
                args: args.into_boxed_slice(),
            })));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::canon::validate_canonical;

    /// A term built through the sanctioned producer, so the corpus is canonical by
    /// construction (V1–V4) rather than by assertion.
    fn term(functor: &str, args: Vec<Value>) -> Value {
        Value::Term(Arc::new(
            TermBlob::new(functor, args.into_boxed_slice()).expect("canonical term"),
        ))
    }

    /// The round-trip corpus: every `Value` variant the renderer can emit, plus the cases
    /// where the variants contend for the same surface text.
    fn corpus() -> Vec<Value> {
        vec![
            // ── Id: the bare-decimal form, at both ends of u128 ──
            Value::Id(0),
            Value::Id(1),
            Value::Id(12_345_678_901_234_567_890),
            Value::Id(u128::MAX),
            // ── Int: i64 including both extremes and negatives ──
            Value::Int(0),
            Value::Int(1),
            Value::Int(-1),
            Value::Int(20),
            Value::Int(i64::MIN),
            Value::Int(i64::MAX),
            // ── Float, including the canonical NaN and the infinities ──
            Value::float(0.0),
            Value::float(3.14),
            Value::float(-2.5),
            Value::float(1e300),
            Value::float(f64::MIN_POSITIVE),
            Value::float(f64::INFINITY),
            Value::float(f64::NEG_INFINITY),
            Value::float(f64::NAN),
            // ── BigInt: canonical only outside i64 range (V1), both signs, beyond u128 ──
            Value::big_int(i128::from(i64::MAX) + 1),
            Value::big_int(i128::from(i64::MIN) - 1),
            Value::big_int_from_decimal("295147905179352825856").expect("2^68"),
            Value::big_int_from_decimal("-295147905179352825856").expect("-2^68"),
            Value::big_int_from_decimal("340282366920938463463374607431768211456")
                .expect("2^128, beyond u128"),
            Value::big_int_from_decimal(
                "123456789012345678901234567890123456789012345678901234567890",
            )
            .expect("60-digit integer"),
            // ── Str, including every shape that collides with another variant ──
            Value::Str(String::new()),
            Value::Str("IMPORTS_FROM".to_string()),
            Value::Str("packages/core/src/index.ts#Foo".to_string()),
            Value::Str("42".to_string()),      // looks like an Id
            Value::Str("0".to_string()),       // looks like an Id
            Value::Str("+7".to_string()),      // u128 accepts a leading '+'
            Value::Str("-7".to_string()),      // looks like an Int
            Value::Str("3.14".to_string()),    // looks like a Float
            Value::Str(u128::MAX.to_string()), // looks like the largest Id
            Value::Str("295147905179352825856".to_string()), // looks like a BigInt
            Value::Str("foo(1,\"x\")".to_string()), // looks like a functor call
            Value::Str("nil".to_string()),     // looks like an arity-0 term
            Value::Str("~int:5".to_string()),  // looks like a tagged Int
            Value::Str("~str:\"nested\"".to_string()), // looks like a tagged Str
            Value::Str("~term:\"f\"(~id:1)".to_string()), // looks like a tagged Term
            Value::Str("~int:5x".to_string()), // tag prefix, malformed payload
            Value::Str("~/.grafema/bin".to_string()), // sigil, not a tag
            Value::Str("a,b)c(d\"e\\f".to_string()), // every delimiter + escapes
            Value::Str("\\".to_string()),
            Value::Str("\"".to_string()),
            Value::Str("многобайтовая строка — ünïcode".to_string()),
            Value::Str("line\nbreak\ttab".to_string()),
            // ── Term: arity 0, flat, nested, and args that collide with other surfaces ──
            term("nil", vec![]),
            term("foo", vec![Value::Id(1), Value::Str("x".to_string())]),
            term(
                "has_premise",
                vec![Value::Str("r1".to_string()), Value::Int(1)],
            ),
            term(
                "outer",
                vec![
                    term("inner", vec![Value::Int(-1), Value::float(0.5)]),
                    Value::big_int_from_decimal("295147905179352825856").expect("2^68"),
                    Value::Str("42".to_string()),
                ],
            ),
            term(
                "rule",
                vec![
                    term("head", vec![Value::Str("p".to_string()), Value::Int(2)]),
                    term(
                        "body",
                        vec![term(
                            "lit",
                            vec![Value::Str("q".to_string()), term("var", vec![])],
                        )],
                    ),
                ],
            ),
            // Functor and args carrying the grammar's own delimiters.
            term(
                "weird,functor)(\"\\",
                vec![Value::Str("a,b)c(\"\\".to_string()), Value::Id(0)],
            ),
            term("", vec![Value::Str(String::new())]),
        ]
    }

    /// THE round-trip property (owner ruling R-14): `parse(render(v)) == v` over every
    /// `Value` variant the renderer can emit. Non-vacuous by construction — the two-arm
    /// parser this codec replaced reads back only `Id` and non-numeric `Str`, so every
    /// `Int`/`Float`/`BigInt`/`Term` case and every numeric-looking `Str` case below fails
    /// against it.
    #[test]
    fn wire_round_trip_is_identity_on_every_value_variant() {
        let corpus = corpus();
        assert!(corpus.len() >= 50, "corpus must actually cover the domain");

        for v in &corpus {
            let wire = value_to_wire_string(v);
            let back = wire_string_to_value(&wire);
            assert_eq!(
                &back, v,
                "round-trip broke: {v:?} rendered as {wire:?} and parsed back as {back:?}"
            );
            // The wire may never inject a non-canonical value into the engine.
            validate_canonical(&back).unwrap_or_else(|e| {
                panic!("parsed value is non-canonical ({e}): {wire:?} → {back:?}")
            });
        }

        // Every variant of the enum is represented, so "for ALL variants" is checked, not
        // assumed. Discriminant counting would not distinguish the collision cases, so the
        // per-variant presence is asserted explicitly.
        let has = |f: fn(&Value) -> bool| corpus.iter().any(f);
        assert!(has(|v| matches!(v, Value::Id(_))), "Id covered");
        assert!(has(|v| matches!(v, Value::Str(_))), "Str covered");
        assert!(has(|v| matches!(v, Value::Int(_))), "Int covered");
        assert!(has(|v| matches!(v, Value::Float(_))), "Float covered");
        assert!(has(|v| matches!(v, Value::BigInt(_))), "BigInt covered");
        assert!(has(|v| matches!(v, Value::Term(_))), "Term covered");
    }

    /// The render direction is injective: distinct values never share a wire string. Without
    /// this the round-trip property could be satisfied by a collapsing encoding.
    #[test]
    fn wire_rendering_is_injective_over_the_corpus() {
        let corpus = corpus();
        let mut seen: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        for v in corpus {
            let wire = value_to_wire_string(&v);
            if let Some(prev) = seen.insert(wire.clone(), v.clone()) {
                assert_eq!(
                    prev, v,
                    "two distinct values share the wire string {wire:?}"
                );
            }
        }
    }

    /// Backward compatibility, the half that matters for deployed clients: an untagged wire
    /// string is read exactly as the two-arm parser read it. Only text that spells a COMPLETE
    /// tagged form takes the new path.
    #[test]
    fn untagged_wire_strings_keep_their_legacy_reading() {
        let legacy = |s: &str| match s.parse::<u128>() {
            Ok(id) => Value::Id(id),
            Err(_) => Value::Str(s.to_string()),
        };
        for s in [
            "0",
            "42",
            "340282366920938463463374607431768211455",
            "IMPORTS_FROM",
            "packages/core/src/index.ts#Foo",
            "",
            "-7",
            "3.14",
            "foo(1,\"x\")",
            "~/.grafema/bin",
            "~int:5x",
            "~notatag:1",
            "~term:\"f\"(",
            "~str:unquoted",
            "~id:notanumber",
        ] {
            assert_eq!(
                wire_string_to_value(s),
                legacy(s),
                "untagged reading changed for {s:?}"
            );
        }
    }

    /// The render direction's compatibility boundary, both sides of it — the values a deployed
    /// client sees today are byte-identical, AND the escape fires exactly where the verbatim
    /// form would lie. Named for both halves on purpose: the second half asserts NON-identity
    /// to the pre-codec wire (`Str("42")` used to render as `42`, which read back as `Id(42)`),
    /// and a name promising only "byte identical" would misreport that as a guarantee.
    #[test]
    fn common_values_render_byte_identically_and_the_escape_fires_only_where_needed() {
        assert_eq!(value_to_wire_string(&Value::Id(0)), "0");
        assert_eq!(
            value_to_wire_string(&Value::Id(u128::MAX)),
            "340282366920938463463374607431768211455"
        );
        assert_eq!(
            value_to_wire_string(&Value::Str("IMPORTS_FROM".to_string())),
            "IMPORTS_FROM"
        );
        assert_eq!(
            value_to_wire_string(&Value::Str("packages/a.ts#Foo".to_string())),
            "packages/a.ts#Foo"
        );
        assert_eq!(value_to_wire_string(&Value::Str(String::new())), "");
        // …and the escape fires only where the verbatim form would lie.
        assert_eq!(
            value_to_wire_string(&Value::Str("42".to_string())),
            "~str:\"42\""
        );
        assert_eq!(value_to_wire_string(&Value::Int(42)), "~int:42");
    }

    /// Non-canonical input is CANONICALIZED rather than transported (module docs, "Canonicality"):
    /// the wire is not a hole in invariants V1–V3.
    #[test]
    fn parsing_canonicalizes_rather_than_transporting_non_canonical_values() {
        // A `~big:` payload inside i64 range comes back as `Int` (V1), never as a BigInt.
        assert_eq!(wire_string_to_value("~big:5"), Value::Int(5));
        assert_eq!(wire_string_to_value("~big:0"), Value::Int(0));
        assert_eq!(
            wire_string_to_value("~big:-9223372036854775808"),
            Value::Int(i64::MIN)
        );
        // `-0.0` normalizes to `+0.0` (V3), and any NaN to the single canonical bit pattern.
        assert_eq!(wire_string_to_value("~float:-0"), Value::Float(0.0));
        assert_eq!(
            wire_string_to_value("~float:NaN"),
            Value::float(f64::NAN),
            "NaN parses to the canonical quiet-NaN pattern"
        );
        for wire in ["~big:5", "~float:-0", "~float:NaN"] {
            validate_canonical(&wire_string_to_value(wire)).expect("parser output is canonical");
        }
    }

    /// Terms nest without the argument list ever becoming ambiguous — the delimiters live
    /// only in QUOTED payloads, where they are escaped.
    #[test]
    fn nested_terms_round_trip_at_depth() {
        let mut v = term("leaf", vec![Value::Str("a,b)".to_string())]);
        for i in 0..16 {
            v = term("wrap", vec![Value::Int(i), v, Value::Str(")".to_string())]);
        }
        let wire = value_to_wire_string(&v);
        assert_eq!(wire_string_to_value(&wire), v, "deep term round-trip");
    }

    /// A tagged form nested one `~term:` per level, `levels` deep, around an `~int:0` leaf.
    fn nested_wire(levels: usize) -> String {
        let mut s = String::with_capacity(levels * 12 + 8);
        for _ in 0..levels {
            s.push_str("~term:\"f\"(");
        }
        s.push_str("~int:0");
        for _ in 0..levels {
            s.push(')');
        }
        s
    }

    /// SAFETY property: nesting past [`MAX_TERM_DEPTH`] is REFUSED, not recursed into.
    ///
    /// The parse direction is fed by unauthenticated wire input, and a Rust stack overflow is
    /// a `SIGABRT` that takes the whole server process down (every connection, every database)
    /// and cannot be caught. Non-vacuous: with the depth check deleted from `parse_tagged`,
    /// this test does not fail — it aborts the test binary with
    /// "fatal runtime error: stack overflow".
    #[test]
    fn wire_input_nested_past_the_cap_is_refused_not_a_stack_overflow() {
        // AT the cap the tagged reading still holds, and still round-trips.
        let at_cap = nested_wire(MAX_TERM_DEPTH as usize);
        let v = wire_string_to_value(&at_cap);
        assert!(
            matches!(v, Value::Term(_)),
            "{MAX_TERM_DEPTH} levels is within the cap → still a Term, got {v:?}"
        );
        assert_eq!(
            value_to_wire_string(&v),
            at_cap,
            "round-trip holds at the cap"
        );

        // PAST the cap — including inputs far larger than the ~55 KB that already overflowed
        // a 2 MiB thread stack — the input takes the legacy reading. No crash, no error path:
        // an over-deep term is just "not a well-formed tagged form", like `~int:5x`.
        for levels in [200_000, 5_000, MAX_TERM_DEPTH as usize + 1] {
            let s = nested_wire(levels);
            assert_eq!(
                wire_string_to_value(&s),
                Value::Str(s.clone()),
                "{levels} levels must fall through to the legacy Str reading"
            );
        }
    }

    /// The whole-input completeness guard (`parse_tagged_complete`) is what keeps "valid
    /// tagged PREFIX + trailing junk" on the legacy reading. Every input here parses as a
    /// tagged value up to some position and then has leftovers, so the PAYLOAD parse succeeds
    /// and only the `pos == len` check can reject it — the case `~int:5x` (rejected by the
    /// payload parse, never reaching the guard) does not cover.
    ///
    /// Non-vacuous: with `parse_tagged_complete` reduced to a bare `p.parse_tagged(0)`, every
    /// assertion below flips (`"~int:5,x"` → `Int(5)`, `"~id:7)tail"` → `Id(7)`, …).
    #[test]
    fn a_tagged_prefix_with_trailing_junk_keeps_the_legacy_reading() {
        for s in [
            "~int:5,x",    // scalar payload stops at `,`, `x` is left over
            "~int:5)tail", // …and at `)`
            "~id:7)tail",
            "~float:1.5,y",
            "~big:295147905179352825856,z",
            "~str:\"a\"tail",       // quoted payload closes, then junk
            "~term:\"f\"tail",      // arity-0 term, then junk
            "~term:\"f\"(~int:1) ", // complete term plus a trailing space
        ] {
            assert_eq!(
                wire_string_to_value(s),
                Value::Str(s.to_string()),
                "a tagged prefix with trailing junk must stay a legacy Str: {s:?}"
            );
            // And the renderer agrees: such a string is NOT self-representing-by-luck, it
            // simply is itself, so it survives a round trip unescaped.
            assert_eq!(value_to_wire_string(&Value::Str(s.to_string())), s);
        }
    }

    /// The ONE semantic break, stated as a test so it cannot be claimed away: the parse
    /// direction is a SYNTACTIC superset of the two-arm reading, not a semantic one. A legacy
    /// client that sends key text which happens to spell a COMPLETE tagged form used to get
    /// `Str(<that text>)` and now gets the tagged variant. (Keys in practice are node ids and
    /// semantic ids, so nothing observed sends these — but the claim "no client that sends
    /// keys breaks" is true only outside this set.)
    #[test]
    fn text_that_spells_a_complete_tagged_form_changes_its_reading() {
        for (sent, now) in [
            ("~int:5", Value::Int(5)),
            ("~float:1.5", Value::float(1.5)),
            ("~big:295147905179352825856", Value::big_int(1_i128 << 68)),
            ("~str:\"x\"", Value::Str("x".to_string())),
            ("~id:9", Value::Id(9)),
        ] {
            let legacy = Value::Str(sent.to_string());
            assert_ne!(
                wire_string_to_value(sent),
                legacy,
                "documented break: {sent:?} no longer reads as a plain string"
            );
            assert_eq!(wire_string_to_value(sent), now, "…it reads as its tag");
            // The RENDER direction has no such break: the escape always fires, so a value the
            // server produces never collides with a tag.
            assert_eq!(
                wire_string_to_value(&value_to_wire_string(&legacy)),
                legacy,
                "rendering {legacy:?} still round-trips to itself"
            );
        }
    }
}
