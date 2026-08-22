//! Layer 1 — canonical value encoding (`canon-v1`) and the total value order.
//!
//! The NORMATIVE byte encoding of a [`Value`] (rofl-fact-model.md §2.5/§2.7/§9): the
//! encoder on which `fid = BLAKE3(canon(perspective, predicate, tuple))[0..16]` (§2.1)
//! and `canonical_state_sha` (§9.1) are built in P2+. It is deliberately SEPARATE from
//! `derive::value::fact_id`'s little-endian encoder: that one stays byte-identical for
//! the in-memory fixpoint (invariant I1); this one is the durable, cross-process form.
//!
//! # canon-v1 layout (varint = unsigned LEB128, matching §9.1's varint style)
//!
//! | Variant | Encoding |
//! |---|---|
//! | `Id(x)` | `0x01` ‖ x as 16 bytes big-endian |
//! | `Str(s)` | `0x02` ‖ varint(byte_len) ‖ UTF-8 bytes |
//! | `Int(i)` | `0x03` ‖ i as 8 bytes big-endian two's complement |
//! | `Float(f)` | `0x04` ‖ canonical bits as 8 bytes BE — `E-VAL-002` if V3 violated |
//! | `BigInt(b)` | `0x05` ‖ varint(len) ‖ bytes — `E-VAL-001` if V1/V2 violated |
//! | `Term(t)` | `0x06` ‖ varint(functor_len) ‖ functor UTF-8 ‖ varint(arity) ‖ each arg recursively |
//!
//! Variant tags + length prefixes make the encoding injective and self-delimiting (no
//! boundary collisions — the same property `fact_id`'s encoder documents), so structural
//! equality of canonical values ⟺ canon-bytes equality.
//!
//! # The total order
//!
//! `impl Ord for Value` is DEFINED as lexicographic comparison of canon-v1 bytes — this
//! is exactly §9.2 row 3 («лексикографически по canon_bytes; внутри — по вариантному
//! тегу, затем по полезной нагрузке»); the variant rank Id < Str < Int < Float < BigInt
//! < Term falls out of the tag bytes. It is implemented structurally (allocation-free)
//! and property-tested for byte-consistency. The order is total and deterministic but
//! deliberately NOT numeric across payloads — §9 needs determinism only; numeric
//! semantics stay in the comparison builtins. For non-canonical values the order remains
//! total (raw payload compare), but such values may not reach canonical boundaries
//! ([`canon_bytes`] / [`validate_canonical`] reject them with `E-VAL-001`/`E-VAL-002`).
//!
//! # E-VAL firing points in P1
//!
//! §2.5 places the canonicality gate «на границе стора»; no fact store exists yet, so
//! the P1 boundaries are [`canon_bytes`] / [`validate_canonical`] and `TermBlob::new`.
//! Abort class: before any commit, same class as `E-MAT-002`/`E-EXEC-001` (§2.3). P2's
//! `FactStore` trait inherits [`validate_canonical`] as its write-boundary gate.

use std::cmp::Ordering;

use crate::datalog::{minimal_twos_complement, TermBlob, Value, CANONICAL_NAN_BITS};

/// The version label of this encoding. P2's fid/state-sha preludes name it so a future
/// canon-v2 can never silently alias canon-v1 hashes.
pub const CANON_VERSION: &str = "canon-v1";

/// A canonicality violation (stable string codes per the `ExecCode` convention;
/// invariant I5 — the code is the load-bearing field, the detail is only a hint).
///
/// - `E-VAL-001` — non-canonical `BigInt`: fits `i64` (V1) or non-minimal
///   two's-complement encoding (V2), incl. recursively inside a `Term`.
/// - `E-VAL-002` — non-canonical `Float`: NaN bits other than the single quiet NaN, or
///   `-0.0` (V3), incl. recursively inside a `Term`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonError {
    /// The stable taxonomy code: `"E-VAL-001"` or `"E-VAL-002"`.
    pub code: &'static str,
    /// Human-oriented hint (never load-bearing).
    pub detail: String,
}

impl std::fmt::Display for CanonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for CanonError {}

/// Check invariant V1+V2 on a raw `BigInt` payload.
fn check_big_int(bytes: &[u8]) -> Result<(), CanonError> {
    let minimal = minimal_twos_complement(bytes);
    if minimal.len() != bytes.len() {
        return Err(CanonError {
            code: "E-VAL-001",
            detail: format!(
                "non-minimal BigInt encoding: {} bytes, minimal form is {} (V2)",
                bytes.len(),
                minimal.len()
            ),
        });
    }
    if bytes.len() <= 8 {
        return Err(CanonError {
            code: "E-VAL-001",
            detail: format!(
                "BigInt of {} bytes fits i64 and must be Int (V1)",
                bytes.len()
            ),
        });
    }
    Ok(())
}

/// Check invariant V3 on raw `Float` bits.
fn check_float(f: f64) -> Result<(), CanonError> {
    let bits = f.to_bits();
    if f.is_nan() && bits != CANONICAL_NAN_BITS {
        return Err(CanonError {
            code: "E-VAL-002",
            detail: format!("non-canonical NaN bits 0x{bits:016x} (V3)"),
        });
    }
    if bits == (-0.0_f64).to_bits() {
        return Err(CanonError {
            code: "E-VAL-002",
            detail: "-0.0 must be canonicalized to +0.0 (V3)".to_string(),
        });
    }
    Ok(())
}

/// Append LEB128 (unsigned) of `x` to `out`.
fn push_varint(out: &mut Vec<u8>, mut x: u64) {
    loop {
        let byte = (x & 0x7F) as u8;
        x >>= 7;
        if x == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

/// Encode LEB128 (unsigned) of `x` into a stack buffer, returning the filled prefix.
/// Allocation-free twin of [`push_varint`] for the structural [`Ord`].
fn leb128_buf(mut x: u64) -> ([u8; 10], usize) {
    let mut buf = [0u8; 10];
    let mut i = 0;
    loop {
        let byte = (x & 0x7F) as u8;
        x >>= 7;
        if x == 0 {
            buf[i] = byte;
            i += 1;
            break;
        }
        buf[i] = byte | 0x80;
        i += 1;
    }
    (buf, i)
}

/// Lexicographic comparison of the LEB128 encodings of two lengths — NOT numeric length
/// comparison (LEB128 is little-endian-grouped, so e.g. varint(300) < varint(200)
/// byte-wise). This is what "Ord = canon-bytes lex" genuinely means for length-prefixed
/// payloads, and the property tests pin it.
fn cmp_leb128(a: u64, b: u64) -> Ordering {
    let (ab, alen) = leb128_buf(a);
    let (bb, blen) = leb128_buf(b);
    ab[..alen].cmp(&bb[..blen])
}

/// Compare two length-prefixed payloads exactly as their canon bytes compare:
/// LEB128(len) bytes lexicographically, then content bytes. (LEB128 is self-delimiting —
/// a shorter varint is never a byte-prefix of a longer one — so this pairwise form equals
/// the lex comparison of the concatenated encodings.)
fn cmp_len_prefixed(a: &[u8], b: &[u8]) -> Ordering {
    cmp_leb128(a.len() as u64, b.len() as u64).then_with(|| a.cmp(b))
}

/// The canon-v1 variant tag byte (also the variant's rank in the total order).
fn canon_tag(v: &Value) -> u8 {
    match v {
        Value::Id(_) => 0x01,
        Value::Str(_) => 0x02,
        Value::Int(_) => 0x03,
        Value::Float(_) => 0x04,
        Value::BigInt(_) => 0x05,
        Value::Term(_) => 0x06,
    }
}

/// Append the canon-v1 encoding of `v` to `out`.
///
/// A P1 canonical-boundary gate: rejects non-canonical values with `E-VAL-001` (BigInt
/// violating V1/V2) or `E-VAL-002` (Float violating V3), including recursively inside a
/// `Term` (errors propagate with the INNER code). On error, `out` may hold a partial
/// prefix — callers abort before any commit (the §2.3 abort class), never publish it.
pub fn canon_bytes(v: &Value, out: &mut Vec<u8>) -> Result<(), CanonError> {
    match v {
        Value::Id(x) => {
            out.push(0x01);
            out.extend_from_slice(&x.to_be_bytes());
        }
        Value::Str(s) => {
            out.push(0x02);
            let bytes = s.as_bytes();
            push_varint(out, bytes.len() as u64);
            out.extend_from_slice(bytes);
        }
        Value::Int(i) => {
            out.push(0x03);
            out.extend_from_slice(&i.to_be_bytes());
        }
        Value::Float(f) => {
            check_float(*f)?;
            out.push(0x04);
            out.extend_from_slice(&f.to_bits().to_be_bytes());
        }
        Value::BigInt(b) => {
            check_big_int(b)?;
            out.push(0x05);
            push_varint(out, b.len() as u64);
            out.extend_from_slice(b);
        }
        Value::Term(t) => {
            out.push(0x06);
            let functor = t.functor.as_bytes();
            push_varint(out, functor.len() as u64);
            out.extend_from_slice(functor);
            push_varint(out, t.args.len() as u64);
            for arg in t.args.iter() {
                canon_bytes(arg, out)?;
            }
        }
    }
    Ok(())
}

/// Validate invariants V1–V4 on `v` without emitting bytes — the pure check twin of
/// [`canon_bytes`], and the gate P2's `FactStore` write boundary inherits.
pub fn validate_canonical(v: &Value) -> Result<(), CanonError> {
    match v {
        Value::Id(_) | Value::Str(_) | Value::Int(_) => Ok(()),
        Value::Float(f) => check_float(*f),
        Value::BigInt(b) => check_big_int(b),
        Value::Term(t) => {
            for arg in t.args.iter() {
                validate_canonical(arg)?;
            }
            Ok(())
        }
    }
}

impl crate::datalog::TermBlob {
    /// Build a term, validating invariants V1–V4 on every arg recursively — the
    /// sanctioned `Term` producer (§2.7): a term built here can never trip the
    /// canonical boundaries. A non-canonical nested arg is rejected with the INNER
    /// `E-VAL-…` code.
    pub fn new(
        functor: impl Into<String>,
        args: impl Into<Box<[Value]>>,
    ) -> Result<TermBlob, CanonError> {
        let blob = TermBlob {
            functor: functor.into(),
            args: args.into(),
        };
        for arg in blob.args.iter() {
            validate_canonical(arg)?;
        }
        Ok(blob)
    }
}

impl PartialOrd for Value {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Value {
    /// The §9.2 total order: lexicographic comparison of canon-v1 bytes, computed
    /// structurally (allocation-free). See the module docs for why this is byte-lex,
    /// not numeric. Total on ALL values (non-canonical payloads compare by raw bytes).
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            // Same variant: payload comparison mirrors the canon byte layout exactly.
            (Value::Id(a), Value::Id(b)) => a.cmp(b), // == BE-16-byte lex
            (Value::Str(a), Value::Str(b)) => cmp_len_prefixed(a.as_bytes(), b.as_bytes()),
            // 8-byte BE two's complement compared as raw bytes — NOT numeric (the sign
            // bit sorts negatives after positives); §9 needs determinism, not numerics.
            (Value::Int(a), Value::Int(b)) => a.to_be_bytes().cmp(&b.to_be_bytes()),
            (Value::Float(a), Value::Float(b)) => {
                a.to_bits().to_be_bytes().cmp(&b.to_bits().to_be_bytes())
            }
            (Value::BigInt(a), Value::BigInt(b)) => cmp_len_prefixed(a, b),
            (Value::Term(a), Value::Term(b)) => {
                cmp_len_prefixed(a.functor.as_bytes(), b.functor.as_bytes())
                    .then_with(|| cmp_leb128(a.args.len() as u64, b.args.len() as u64))
                    .then_with(|| {
                        for (x, y) in a.args.iter().zip(b.args.iter()) {
                            let ord = x.cmp(y);
                            if ord != Ordering::Equal {
                                return ord;
                            }
                        }
                        // Arities compared equal above, so the zip covered every arg.
                        Ordering::Equal
                    })
            }
            // Different variants: decided by the canon-v1 tag byte
            // (Id < Str < Int < Float < BigInt < Term). `canon_tag` matches every
            // variant explicitly; same-variant pairs were consumed by the arms above.
            (a, b) => canon_tag(a).cmp(&canon_tag(b)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // ── deterministic PRNG (xorshift64*) — no external dep, reproducible ──

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// A random CANONICAL value; `depth` bounds Term nesting (≤ 4 from the top call).
    fn random_canonical(rng: &mut Rng, depth: u32) -> Value {
        let variants = if depth == 0 { 5 } else { 6 };
        match rng.below(variants) {
            0 => Value::Id((u128::from(rng.next()) << 64) | u128::from(rng.next())),
            1 => {
                let len = rng.below(12) as usize;
                let s: String = (0..len)
                    .map(|_| char::from(b'a' + (rng.below(26) as u8)))
                    .collect();
                Value::Str(s)
            }
            2 => Value::Int(rng.next() as i64),
            3 => Value::float(f64::from_bits(rng.next())), // canonicalizes NaN payloads
            4 => {
                // A 128-bit magnitude beyond i64: canonical via the constructor (may
                // stay BigInt or, rarely, demote to Int — still canonical).
                let hi = rng.next() | 1; // ensure a high half → outside i64 range
                Value::big_int(i128::from_bits_pair(hi, rng.next()))
            }
            _ => {
                let arity = rng.below(3) as usize;
                let args: Vec<Value> =
                    (0..arity).map(|_| random_canonical(rng, depth - 1)).collect();
                let functor: String = (0..(1 + rng.below(6)) as usize)
                    .map(|_| char::from(b'f' + (rng.below(8) as u8)))
                    .collect();
                Value::Term(Arc::new(
                    crate::datalog::TermBlob::new(functor, args).expect("canonical args"),
                ))
            }
        }
    }

    trait Bits128 {
        fn from_bits_pair(hi: u64, lo: u64) -> i128;
    }
    impl Bits128 for i128 {
        fn from_bits_pair(hi: u64, lo: u64) -> i128 {
            ((hi as i128) << 64) | (lo as i128 & 0xFFFF_FFFF_FFFF_FFFF)
        }
    }

    fn canon(v: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        canon_bytes(v, &mut out).expect("canonical value must encode");
        out
    }

    // ── total-order laws over ≥1000 random canonical values (incl. nested Terms) ──

    #[test]
    fn total_order_laws_hold_on_random_canonical_values() {
        let mut rng = Rng(0x5EED_0001);
        let vals: Vec<Value> = (0..1200).map(|_| random_canonical(&mut rng, 4)).collect();
        // Totality + antisymmetry + Eq⟺Equal on sampled pairs.
        for i in 0..vals.len() {
            for j in (i.saturating_sub(40))..vals.len().min(i + 40) {
                let (a, b) = (&vals[i], &vals[j]);
                let ab = a.cmp(b);
                let ba = b.cmp(a);
                assert_eq!(ab, ba.reverse(), "antisymmetry: {a:?} vs {b:?}");
                assert_eq!(
                    ab == Ordering::Equal,
                    a == b,
                    "Eq must agree with Ordering::Equal: {a:?} vs {b:?}"
                );
            }
        }
        // Transitivity on sampled sorted triples.
        let mut sorted = vals.clone();
        sorted.sort(); // would panic if Ord were inconsistent
        for w in sorted.windows(3) {
            assert!(w[0] <= w[1] && w[1] <= w[2] && w[0] <= w[2], "transitivity");
        }
    }

    #[test]
    fn ord_is_byte_consistent_with_canon_bytes_lex() {
        let mut rng = Rng(0x5EED_0002);
        for _ in 0..1500 {
            let a = random_canonical(&mut rng, 3);
            let b = random_canonical(&mut rng, 3);
            assert_eq!(
                a.cmp(&b),
                canon(&a).cmp(&canon(&b)),
                "Ord and §9.2 canon-bytes lex must be ONE order: {a:?} vs {b:?}"
            );
        }
    }

    /// The multi-byte LEB128 branch of the §9.2 order, which the PRNG battery never
    /// reaches (its strings are ≤11 bytes, so every varint there is single-byte):
    /// varint(300) = [0xAC, 0x02] and varint(200) = [0xC8, 0x01], so a length-300
    /// payload sorts BEFORE a length-200 one — byte-lex of the ENCODED lengths, not
    /// numeric length comparison. Pins `cmp_leb128`'s documented inversion on both
    /// length-prefixed variants (Str and BigInt) with ≥128-byte payloads.
    #[test]
    fn multi_byte_varint_lengths_order_by_encoding_bytes_not_numeric_length() {
        // Str: lengths 300 vs 200, identical content bytes.
        let a = Value::Str("x".repeat(300));
        let b = Value::Str("x".repeat(200));
        assert_eq!(
            a.cmp(&b),
            canon(&a).cmp(&canon(&b)),
            "Str: Ord must equal canon-bytes lex across the varint width boundary"
        );
        assert_eq!(
            a.cmp(&b),
            Ordering::Less,
            "varint(300)=[AC 02] < varint(200)=[C8 01] byte-lex — the inversion is real"
        );
        // BigInt: 300- vs 200-byte minimal positive magnitudes (leading 0x7F is
        // non-redundant, so the constructor keeps the full width).
        let big = |len: usize| {
            let bytes = vec![0x7F_u8; len];
            let v = Value::big_int_from_be_bytes(&bytes);
            assert!(matches!(v, Value::BigInt(_)), "{len}-byte magnitude stays BigInt");
            v
        };
        let (ba, bb) = (big(300), big(200));
        assert_eq!(
            ba.cmp(&bb),
            canon(&ba).cmp(&canon(&bb)),
            "BigInt: Ord must equal canon-bytes lex across the varint width boundary"
        );
        assert_eq!(ba.cmp(&bb), Ordering::Less);
        // Same lengths, differing content: content bytes decide after equal prefixes.
        let c = Value::Str(format!("{}y", "x".repeat(299)));
        assert_eq!(a.cmp(&c), Ordering::Less, "equal varints fall through to content");
        assert_eq!(a.cmp(&c), canon(&a).cmp(&canon(&c)));
    }

    // ── injectivity probes ──

    #[test]
    fn injectivity_no_boundary_or_cross_variant_collisions() {
        // Tuple boundary: [Str "ab", Str "c"] vs [Str "a", Str "bc"].
        let enc = |vals: &[Value]| {
            let mut out = Vec::new();
            for v in vals {
                canon_bytes(v, &mut out).unwrap();
            }
            out
        };
        assert_ne!(
            enc(&[Value::Str("ab".into()), Value::Str("c".into())]),
            enc(&[Value::Str("a".into()), Value::Str("bc".into())]),
            "length prefixes must prevent boundary collisions"
        );
        // Cross-variant: Id(1) vs Int(1) vs Str "\x01" vs a BigInt — all distinct.
        let big = Value::big_int(i128::from(i64::MAX) + 1);
        let mut encodings = vec![
            canon(&Value::Id(1)),
            canon(&Value::Int(1)),
            canon(&Value::Str("\u{1}".into())),
            canon(&big),
        ];
        encodings.sort();
        encodings.dedup();
        assert_eq!(encodings.len(), 4, "variant tags must keep same-surface values distinct");
        // Term arg split: f(x, y) vs f(xy) vs fx(y).
        let t = |functor: &str, args: &[&str]| {
            Value::Term(Arc::new(
                crate::datalog::TermBlob::new(
                    functor,
                    args.iter().map(|s| Value::Str((*s).into())).collect::<Vec<_>>(),
                )
                .unwrap(),
            ))
        };
        let mut terms = vec![
            canon(&t("f", &["x", "y"])),
            canon(&t("f", &["xy"])),
            canon(&t("fx", &["y"])),
        ];
        terms.sort();
        terms.dedup();
        assert_eq!(terms.len(), 3, "functor/arity/arg prefixes must not collide");
    }

    // ── golden canonical byte vectors (cross-process/cross-version hash stability) ──

    #[test]
    fn golden_canonical_byte_vectors() {
        // One committed byte-for-byte expected encoding per variant.
        assert_eq!(
            canon(&Value::Id(0x0102_0304)),
            [
                0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x02, 0x03, 0x04
            ]
        );
        assert_eq!(canon(&Value::Str("ab".into())), [0x02, 0x02, b'a', b'b']);
        assert_eq!(
            canon(&Value::Int(-2)),
            [0x03, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE]
        );
        assert_eq!(
            canon(&Value::float(1.5)),
            [0x04, 0x3F, 0xF8, 0, 0, 0, 0, 0, 0]
        );
        // 2^68: 9-byte minimal two's complement 0x10 00 00 00 00 00 00 00 00.
        let two_68 = Value::big_int(1_i128 << 68);
        assert_eq!(
            canon(&two_68),
            [0x05, 0x09, 0x10, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        // Nested term: pair("a", inner(7)) — functor len 4, arity 2.
        let inner = Value::Term(Arc::new(
            crate::datalog::TermBlob::new("inner", vec![Value::Int(7)]).unwrap(),
        ));
        let pair = Value::Term(Arc::new(
            crate::datalog::TermBlob::new("pair", vec![Value::Str("a".into()), inner]).unwrap(),
        ));
        assert_eq!(
            canon(&pair),
            [
                0x06, 0x04, b'p', b'a', b'i', b'r', 0x02, // pair/2
                0x02, 0x01, b'a', // Str "a"
                0x06, 0x05, b'i', b'n', b'n', b'e', b'r', 0x01, // inner/1
                0x03, 0, 0, 0, 0, 0, 0, 0, 0x07, // Int 7
            ]
        );
        // The canonical quiet NaN is f64::NAN's bits on this target (asserted so a
        // platform surprise fails loudly), and blake3 over the goldens is pinned.
        assert_eq!(f64::NAN.to_bits(), CANONICAL_NAN_BITS);
        let mut all = Vec::new();
        for v in [
            Value::Id(0x0102_0304),
            Value::Str("ab".into()),
            Value::Int(-2),
            Value::float(1.5),
            two_68,
            pair,
        ] {
            canon_bytes(&v, &mut all).unwrap();
        }
        assert_eq!(
            blake3::hash(&all).to_hex().as_str(),
            "ed03c7cd4656f2424b5e61993607c69f5ebda5305e17153dbe9cd8f052431cb2",
            "canon-v1 golden hash must be stable across processes and versions"
        );
    }

    // ── canonicalizing constructors ──

    #[test]
    fn big_int_constructor_canonicalizes_per_v1_v2() {
        assert_eq!(Value::big_int(i128::from(i64::MAX)), Value::Int(i64::MAX));
        assert_eq!(Value::big_int(i128::from(i64::MIN)), Value::Int(i64::MIN));
        match Value::big_int(i128::from(i64::MIN) - 1) {
            Value::BigInt(b) => assert_eq!(b.len(), 9, "minimal 9-byte encoding"),
            other => panic!("i64::MIN - 1 must be BigInt, got {other:?}"),
        }
        match Value::big_int(1_i128 << 68) {
            Value::BigInt(b) => {
                assert_eq!(&b[..], &[0x10, 0, 0, 0, 0, 0, 0, 0, 0], "2^68 minimal bytes")
            }
            other => panic!("2^68 must be BigInt, got {other:?}"),
        }
        // Redundant sign bytes are stripped by the byte-level constructor.
        assert_eq!(
            Value::big_int_from_be_bytes(&[0x00, 0x00, 0x7F]),
            Value::Int(0x7F)
        );
        assert_eq!(Value::big_int_from_be_bytes(&[0xFF, 0xFF, 0x80]), Value::Int(-128));
        assert_eq!(Value::big_int_from_be_bytes(&[]), Value::Int(0));
    }

    #[test]
    fn big_int_from_decimal_round_trips_exactly() {
        let v = Value::big_int_from_decimal("295147905179352825856").expect("2^68 parses");
        assert_eq!(v, Value::big_int(1_i128 << 68));
        assert_eq!(v.as_str(), "295147905179352825856");
        let neg = Value::big_int_from_decimal("-295147905179352825856").unwrap();
        assert_eq!(neg, Value::big_int(-(1_i128 << 68)));
        assert_eq!(neg.as_str(), "-295147905179352825856");
        // i64-range decimals demote to Int (V1).
        assert_eq!(Value::big_int_from_decimal("42").unwrap(), Value::Int(42));
        assert_eq!(
            Value::big_int_from_decimal("-9223372036854775808").unwrap(),
            Value::Int(i64::MIN)
        );
        // Wider than 128 bits: 2^200 round-trips through decimal exactly.
        let big = Value::big_int_from_decimal(
            "1606938044258990275541962092341162602522202993782792835301376",
        )
        .unwrap();
        assert_eq!(
            big.as_str(),
            "1606938044258990275541962092341162602522202993782792835301376"
        );
        assert!(Value::big_int_from_decimal("12x3").is_none());
        assert!(Value::big_int_from_decimal("").is_none());
    }

    #[test]
    fn float_constructor_canonicalizes_per_v3() {
        assert_eq!(Value::float(-0.0), Value::float(0.0));
        match Value::float(-0.0) {
            Value::Float(f) => assert_eq!(f.to_bits(), 0, "-0.0 → +0.0 bits"),
            other => panic!("float() must produce Float, got {other:?}"),
        }
        // Any-payload NaN → the single canonical quiet NaN.
        let payload_nan = f64::from_bits(0x7FF8_0000_0000_BEEF);
        match Value::float(payload_nan) {
            Value::Float(f) => assert_eq!(f.to_bits(), CANONICAL_NAN_BITS),
            other => panic!("float() must produce Float, got {other:?}"),
        }
        assert_eq!(Value::float(2.25), Value::Float(2.25));
    }

    #[test]
    fn term_roundtrip_encode_decode_reencode_is_idempotent() {
        let mut rng = Rng(0x5EED_0003);
        for _ in 0..200 {
            let arity = rng.below(4) as usize;
            let args: Vec<Value> = (0..arity).map(|_| random_canonical(&mut rng, 2)).collect();
            let term = Value::Term(Arc::new(
                crate::datalog::TermBlob::new("probe", args).expect("canonical"),
            ));
            let bytes = canon(&term);
            let (decoded, consumed) = decode_value(&bytes).expect("decode");
            assert_eq!(consumed, bytes.len(), "decoder must consume the full encoding");
            assert_eq!(decoded, term, "decode must reproduce the value");
            assert_eq!(canon(&decoded), bytes, "re-encode must be byte-identical");
        }
    }

    /// Test-only canon-v1 decoder (the production decoder lands with the P2 store).
    fn decode_value(bytes: &[u8]) -> Option<(Value, usize)> {
        fn varint(bytes: &[u8]) -> Option<(u64, usize)> {
            let mut x = 0u64;
            for (i, b) in bytes.iter().enumerate() {
                x |= u64::from(b & 0x7F) << (7 * i);
                if b & 0x80 == 0 {
                    return Some((x, i + 1));
                }
            }
            None
        }
        let tag = *bytes.first()?;
        let rest = &bytes[1..];
        match tag {
            0x01 => Some((
                Value::Id(u128::from_be_bytes(rest.get(..16)?.try_into().ok()?)),
                17,
            )),
            0x02 => {
                let (len, vl) = varint(rest)?;
                let s = rest.get(vl..vl + len as usize)?;
                Some((Value::Str(String::from_utf8(s.to_vec()).ok()?), 1 + vl + len as usize))
            }
            0x03 => Some((
                Value::Int(i64::from_be_bytes(rest.get(..8)?.try_into().ok()?)),
                9,
            )),
            0x04 => Some((
                Value::Float(f64::from_bits(u64::from_be_bytes(
                    rest.get(..8)?.try_into().ok()?,
                ))),
                9,
            )),
            0x05 => {
                let (len, vl) = varint(rest)?;
                let b = rest.get(vl..vl + len as usize)?;
                Some((Value::BigInt(Arc::from(b)), 1 + vl + len as usize))
            }
            0x06 => {
                let (flen, fl) = varint(rest)?;
                let functor =
                    String::from_utf8(rest.get(fl..fl + flen as usize)?.to_vec()).ok()?;
                let mut pos = fl + flen as usize;
                let (arity, al) = varint(&rest[pos..])?;
                pos += al;
                let mut args = Vec::with_capacity(arity as usize);
                for _ in 0..arity {
                    let (v, used) = decode_value(&rest[pos..])?;
                    args.push(v);
                    pos += used;
                }
                Some((
                    Value::Term(Arc::new(TermBlob {
                        functor,
                        args: args.into_boxed_slice(),
                    })),
                    1 + pos,
                ))
            }
            _ => None,
        }
    }
    use crate::datalog::TermBlob;

    // ── E-VAL abort paths ──

    #[test]
    fn e_val_001_fires_on_noncanonical_big_int() {
        // Fits i64 (V1).
        let raw = Value::BigInt(Arc::from(&[0x01u8, 0x02][..]));
        let mut out = Vec::new();
        let err = canon_bytes(&raw, &mut out).unwrap_err();
        assert_eq!(err.code, "E-VAL-001");
        assert_eq!(validate_canonical(&raw).unwrap_err().code, "E-VAL-001");
        // Redundant leading 0x00 (V2).
        let padded: Vec<u8> = std::iter::once(0x00)
            .chain(std::iter::repeat(0x11).take(9))
            .collect();
        let raw = Value::BigInt(Arc::from(&padded[..]));
        assert_eq!(validate_canonical(&raw).unwrap_err().code, "E-VAL-001");
        // Redundant leading 0xFF before a set top bit (V2).
        let padded: Vec<u8> = std::iter::once(0xFF)
            .chain(std::iter::repeat(0x91).take(9))
            .collect();
        let raw = Value::BigInt(Arc::from(&padded[..]));
        assert_eq!(validate_canonical(&raw).unwrap_err().code, "E-VAL-001");
        // A genuinely canonical 9-byte BigInt passes.
        let ok = Value::big_int(1_i128 << 68);
        assert!(validate_canonical(&ok).is_ok());
    }

    #[test]
    fn e_val_002_fires_on_noncanonical_float() {
        let neg_zero = Value::Float(-0.0);
        assert_eq!(validate_canonical(&neg_zero).unwrap_err().code, "E-VAL-002");
        let mut out = Vec::new();
        assert_eq!(canon_bytes(&neg_zero, &mut out).unwrap_err().code, "E-VAL-002");
        // Signaling-NaN bit pattern (quiet bit clear, nonzero payload).
        let snan = Value::Float(f64::from_bits(0x7FF0_0000_0000_0001));
        assert_eq!(validate_canonical(&snan).unwrap_err().code, "E-VAL-002");
        // Payload-carrying quiet NaN is also non-canonical (V3 names ONE pattern).
        let qnan_payload = Value::Float(f64::from_bits(0x7FF8_0000_0000_0001));
        assert_eq!(validate_canonical(&qnan_payload).unwrap_err().code, "E-VAL-002");
        // The canonical NaN and ordinary floats pass.
        assert!(validate_canonical(&Value::float(f64::NAN)).is_ok());
        assert!(validate_canonical(&Value::Float(3.25)).is_ok());
    }

    #[test]
    fn e_val_errors_propagate_recursively_from_terms() {
        // TermBlob::new rejects a non-canonical nested arg with the INNER code.
        let bad_float = Value::Float(-0.0);
        let inner = TermBlob {
            functor: "inner".to_string(),
            args: vec![bad_float].into_boxed_slice(),
        };
        let err =
            TermBlob::new("outer", vec![Value::Term(Arc::new(inner))]).unwrap_err();
        assert_eq!(err.code, "E-VAL-002");
        let bad_int = Value::BigInt(Arc::from(&[0x05u8][..]));
        let err = TermBlob::new("outer", vec![bad_int]).unwrap_err();
        assert_eq!(err.code, "E-VAL-001");
        // canon_bytes propagates the same way through a hand-assembled Term.
        let smuggled = Value::Term(Arc::new(TermBlob {
            functor: "smuggled".to_string(),
            args: vec![Value::Float(-0.0)].into_boxed_slice(),
        }));
        let mut out = Vec::new();
        assert_eq!(canon_bytes(&smuggled, &mut out).unwrap_err().code, "E-VAL-002");
    }
}
