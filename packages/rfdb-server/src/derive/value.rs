//! Layer 1 — values and facts.
//!
//! Reuses the query engine's `Value` type from `crate::datalog`. Defines `Fact` (a boxed slice of
//! `Value`), `Row`, and the deterministic `fact_id = u64 hash(pred_id, key)` used to
//! re-shuffle and dedup tuples in the fixpoint. Invariant I1: `fact_id` is fully
//! deterministic (independent of worker count and rule order).

use crate::datalog::Value;

/// A predicate identifier, resolved once per plan (no string round-trips in the
/// fixpoint hot path). The mapping from predicate name to id is owned by the planner;
/// this layer only consumes the resolved `u64`.
pub type PredicateId = u64;

/// A materialized tuple of values. `Box<[Value]>` keeps facts immutable and compact
/// (one heap allocation, no spare capacity) once produced by a join or scan.
///
/// Per spec §5: `Fact = Box<[Value]>`; batches are `Vec<Row>` (a column-major layout
/// may later sit behind the same interfaces).
pub type Fact = Box<[Value]>;

/// A row produced or consumed by the executor. Currently a transparent alias for
/// [`Fact`]; kept distinct so the batch/iterator interfaces can migrate to a
/// column-major representation without touching call sites.
pub type Row = Fact;

/// Byte tags for the value variants, mixed into the canonical encoding so that values
/// of different variants with the same surface bytes never collide (e.g. the integer
/// `1` vs. the one-byte string `"\x01"`).
const TAG_ID: u8 = 0x01;
const TAG_STR: u8 = 0x02;
const TAG_INT: u8 = 0x03;
const TAG_FLOAT: u8 = 0x04;

/// Append the canonical, variant-tagged byte encoding of a single value to `out`.
///
/// The encoding is injective per variant: each value is prefixed by its variant tag,
/// and string payloads are length-prefixed so that no concatenation of values can be
/// re-parsed into a different sequence of values. This makes the hash order-sensitive
/// and free of boundary collisions.
fn encode_value(out: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Id(id) => {
            out.push(TAG_ID);
            out.extend_from_slice(&id.to_le_bytes());
        }
        Value::Str(s) => {
            out.push(TAG_STR);
            let bytes = s.as_bytes();
            out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
            out.extend_from_slice(bytes);
        }
        // Typed numerics: fixed-width payloads, Float by canonical bit pattern so fact identity
        // agrees with `Value`'s `Eq`/`Hash` (same to_bits discipline).
        Value::Int(i) => {
            out.push(TAG_INT);
            out.extend_from_slice(&i.to_le_bytes());
        }
        Value::Float(f) => {
            out.push(TAG_FLOAT);
            out.extend_from_slice(&f.to_bits().to_le_bytes());
        }
    }
}

/// Deterministic fact identity: `u64 hash(predicate_id, key tuple)`.
///
/// Used to re-shuffle and dedup tuples across workers in the semi-naive fixpoint.
/// The hash is a blake3 digest (the same determinism primitive used across
/// `storage_v2`) over the predicate id followed by the variant-tagged, length-prefixed
/// encoding of each key value. Properties guaranteed for invariant I1:
///
/// - **Deterministic**: identical `(predicate_id, key)` inputs always yield the same
///   id, independent of process, platform endianness handling (LE is forced), worker
///   count, and rule evaluation order.
/// - **Order-sensitive on the key**: permuting `key` changes the id (each value is
///   tagged and the tuple is positionally encoded).
/// - **Predicate-scoped**: the same key under a different predicate id yields a
///   different id.
pub fn fact_id(predicate_id: PredicateId, key: &[Value]) -> u64 {
    let mut buf: Vec<u8> = Vec::with_capacity(8 + key.len() * 16);
    buf.extend_from_slice(&predicate_id.to_le_bytes());
    for value in key {
        encode_value(&mut buf, value);
    }
    let digest = blake3::hash(&buf);
    u64::from_le_bytes(
        digest.as_bytes()[0..8]
            .try_into()
            .expect("blake3 digest >= 8 bytes"),
    )
}

/// Resolve a variable name to its slot index within an ordered variable list.
///
/// Variable→slot resolution happens once per plan (spec §5); this helper performs the
/// trivial lookup over the plan's canonical variable ordering. Returns `None` for a
/// variable not present in `vars` (e.g. a wildcard or an out-of-scope name), which the
/// caller treats as "not captured".
pub fn var_slot(vars: &[String], name: &str) -> Option<usize> {
    vars.iter().position(|v| v == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Value {
        Value::Str(v.to_string())
    }

    #[test]
    fn fact_id_is_deterministic() {
        let key = [Value::Id(42), s("queue:publish")];
        let a = fact_id(7, &key);
        let b = fact_id(7, &key);
        assert_eq!(a, b, "same (predicate_id, key) must yield same fact_id");
    }

    #[test]
    fn fact_id_is_order_sensitive_on_key() {
        let forward = [s("a"), s("b")];
        let reversed = [s("b"), s("a")];
        assert_ne!(
            fact_id(1, &forward),
            fact_id(1, &reversed),
            "permuting the key must change the fact_id"
        );
    }

    #[test]
    fn fact_id_is_predicate_scoped() {
        let key = [Value::Id(1)];
        assert_ne!(
            fact_id(1, &key),
            fact_id(2, &key),
            "same key under a different predicate must change the fact_id"
        );
    }

    #[test]
    fn fact_id_distinguishes_variants_without_boundary_collisions() {
        // Integer-like Id(1) (TAG_ID + LE bytes) must not collide with the one-byte
        // string "\x01", and adjacent values must not merge across boundaries.
        assert_ne!(fact_id(0, &[Value::Id(1)]), fact_id(0, &[s("\u{1}")]));
        assert_ne!(
            fact_id(0, &[s("ab"), s("c")]),
            fact_id(0, &[s("a"), s("bc")]),
            "length-prefixing must prevent boundary collisions"
        );
    }

    #[test]
    fn var_slot_resolves_position() {
        let vars = vec!["X".to_string(), "Y".to_string(), "Z".to_string()];
        assert_eq!(var_slot(&vars, "X"), Some(0));
        assert_eq!(var_slot(&vars, "Z"), Some(2));
        assert_eq!(var_slot(&vars, "Q"), None);
    }

    #[test]
    fn fact_alias_round_trips() {
        let f: Fact = vec![Value::Id(9), s("k")].into_boxed_slice();
        let r: Row = f.clone();
        assert_eq!(f, r);
        assert_eq!(r.len(), 2);
    }
}
