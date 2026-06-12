//! W8 Part 3: durable D2-pin sidecar — the maintain cache across server restarts.
//!
//! The engine's in-process D2 cache (`GraphEngineV2::derive_materialize_cache`) makes
//! the 2nd+ `@materialize` of a program work-proportional, but it dies with the process:
//! a cold server (CI, restart) pays a full scratch eval per program. This module persists
//! the pair the cache holds — *(manifest version the evaluation is valid at, the derived
//! [`Evaluation`])* — to a sidecar file per program in the database directory, and
//! rehydrates it on the first call after a cold start.
//!
//! ## Soundness — when a sidecar may be written, and when a load may be trusted
//!
//! The rehydrate contract is EXACT-STATE only (the user-set scope: «версия не совпала →
//! scratch, no laundering»):
//!
//! * A loaded sidecar is used iff `stored version == current snapshot version` AND
//!   `stored tombstone hash == blake3 of the current snapshot's tombstone set`. Segments
//!   are immutable per version and the tombstone set is the only same-version-mutable
//!   visibility input (the W9 delete→re-add lesson: `remove_tombstone_*` resurrects
//!   committed records IN the current version — the version number alone is NOT the data
//!   identity, so the tombstone CONTENT hash is part of the key). Match ⇒ the visible
//!   base data is identical to what the evaluation was computed over ⇒ handing the pair
//!   to `derive_for_materialize` takes its unchanged-graph short-circuit. Mismatch ⇒ the
//!   caller falls back to scratch, exactly as before.
//!
//! * What may be persisted, after a successful cached write-back:
//!   - **Empty write-back delta** (nothing added/removed ⇒ no version flip): the pre-eval
//!     snapshot IS the current state; persist `(snapshot.version, hash, evaluation)`
//!     unconditionally. `evaluation == scratch(snapshot)` by construction.
//!   - **Non-empty delta** (the write-back flushed ⇒ version advanced): the evaluation
//!     was computed at the PRE-commit snapshot, but the rehydrate key must be the
//!     POST-commit version (that is what a restarted server will see). Claiming
//!     `evaluation == scratch(post-commit)` is sound iff BOTH hold:
//!     1. **No riders**: at write-back entry the engine had NO buffered writes (store
//!        write buffers) and NO pending tombstones. The write-back commits via the
//!        engine `flush()`, which publishes ALL pending state (MVCC B2
//!        visibility=publish) — buffered `add_nodes`/`add_edges` from any connection
//!        and pending deletes ride the commit. Riders can be of ANY type (including
//!        edge types the program reads, and node facts the disjointness check below
//!        never inspects), so with riders the post-commit snapshot contains data the
//!        evaluation never saw. `GraphEngineV2::persist_durable_pin` takes the probe
//!        (`riders_pending`) captured before the write-back mutates anything.
//!     2. **Read/write disjointness**: the program provably does not READ what its own
//!        write-back wrote: edge-only specs (no `@materialize_node` — a node write
//!        changes `node`/`attr` ground facts) and every body `edge`/`incoming`/
//!        `edge_attr` literal carries a CONSTANT edge type disjoint from the spec types
//!        ([`program_reads_written_edge_types`]; a variable/wildcard type position is
//!        conservatively treated as reading everything).
//!     Then the commit published exactly the program's own delta, which altered only
//!     base facts no rule body can observe, so the fixpoint at the post-commit snapshot
//!     is byte-identical. Programs/runs outside this (self-feeding CALLS packs, node
//!     packs, riders pending) get NO sidecar — their stale file (if any) is removed;
//!     restart pays scratch (the correctness floor, I5).
//!
//! * The blob carries a BLAKE3 checksum over the entire payload; any torn/corrupt file
//!   deserializes to `None` (⇒ scratch), never to a wrong evaluation.
//!
//! The sidecar directory ([`SIDECAR_DIR`]) lives inside the db dir and is deleted by the
//! durable clear (W8 Part 2).

use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use crate::datalog::{Term, Value};
use crate::derive::exec::Evaluation;
use crate::derive::materialize::MaterializeSpec;
use crate::storage_v2::shard::TombstoneSet;

/// Sidecar directory name inside the database directory.
pub const SIDECAR_DIR: &str = "derive_pins";

/// Format magic + version. Bump on any layout change: an unknown magic loads as `None`
/// (⇒ scratch), never as a misparse.
const MAGIC: &[u8; 8] = b"RFD2PIN1";

/// One durable pin: the evaluation is valid exactly at `(version, tombstone_hash)`.
pub struct PinSidecar {
    /// Manifest version the evaluation is valid at (post-commit for a non-empty
    /// write-back delta, the pinned snapshot version for an empty one).
    pub version: u64,
    /// BLAKE3 over the sorted tombstone set content at that state.
    pub tombstone_hash: [u8; 32],
    /// The derived relations (the same `Evaluation` the in-process cache holds).
    pub evaluation: Evaluation,
}

/// Deterministic content hash of a tombstone set: BLAKE3 over the SORTED node ids and
/// the SORTED edge keys (HashSet iteration order is nondeterministic — sorting makes the
/// hash a pure function of the set content, stable across processes and runs).
pub fn tombstone_hash(ts: &TombstoneSet) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    let mut node_ids: Vec<u128> = ts.node_ids.iter().copied().collect();
    node_ids.sort_unstable();
    hasher.update(&(node_ids.len() as u64).to_le_bytes());
    for id in node_ids {
        hasher.update(&id.to_le_bytes());
    }
    let mut edge_keys: Vec<(u128, u128, &str)> = ts
        .edge_keys
        .iter()
        .map(|(s, d, t)| (*s, *d, t.as_ref()))
        .collect();
    edge_keys.sort_unstable();
    hasher.update(&(edge_keys.len() as u64).to_le_bytes());
    for (s, d, t) in edge_keys {
        hasher.update(&s.to_le_bytes());
        hasher.update(&d.to_le_bytes());
        hasher.update(&(t.len() as u64).to_le_bytes());
        hasher.update(t.as_bytes());
    }
    *hasher.finalize().as_bytes()
}

/// Does any body literal READ an edge type the program's `@materialize` specs WRITE?
/// `true` ⇒ the program may observe its own write-back ⇒ a post-commit sidecar would be
/// unsound. A variable or wildcard in a type position is conservatively "reads every
/// type". Only `edge` / `incoming` / `edge_attr` read edges; their type argument is
/// position 2 in all three (edge(S,D,T) / incoming(D,S,T) / edge_attr(S,D,T,K,V)).
pub fn program_reads_written_edge_types(
    rules: &[&crate::datalog::Rule],
    specs: &[MaterializeSpec],
) -> bool {
    let written: std::collections::HashSet<&str> =
        specs.iter().map(|s| s.edge_type.as_str()).collect();
    if written.is_empty() {
        return false;
    }
    for rule in rules {
        for lit in rule.body() {
            let atom = lit.atom();
            let pred = atom.predicate();
            if !matches!(pred, "edge" | "incoming" | "edge_attr") {
                continue;
            }
            match atom.args().get(2) {
                Some(Term::Const(t)) => {
                    if written.contains(t.as_str()) {
                        return true;
                    }
                }
                Some(Term::Lit(Value::Str(t))) => {
                    if written.contains(t.as_str()) {
                        return true;
                    }
                }
                // Variable / wildcard / non-string type position: reads everything.
                _ => return true,
            }
        }
    }
    false
}

/// Sidecar file path for one program key.
fn sidecar_path(db_path: &Path, program_key: u64) -> PathBuf {
    db_path.join(SIDECAR_DIR).join(format!("{program_key:016x}.pin"))
}

/// Persist a pin atomically (temp file + rename). Errors are the caller's to log —
/// persistence is an optimization; a failed save must never fail the materialize.
/// Takes the evaluation by reference: the hot caller (`persist_durable_pin`, once per
/// `@materialize`) must not pay a full derived-relations clone just to serialize.
pub fn save(
    db_path: &Path,
    program_key: u64,
    version: u64,
    tombstone_hash: &[u8; 32],
    evaluation: &Evaluation,
) -> io::Result<()> {
    let dir = db_path.join(SIDECAR_DIR);
    std::fs::create_dir_all(&dir)?;

    let mut payload: Vec<u8> = Vec::new();
    payload.extend_from_slice(&version.to_le_bytes());
    payload.extend_from_slice(tombstone_hash);
    encode_evaluation(evaluation, &mut payload);
    let checksum = blake3::hash(&payload);

    let tmp = dir.join(format!("{program_key:016x}.pin.tmp"));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(MAGIC)?;
        f.write_all(&(payload.len() as u64).to_le_bytes())?;
        f.write_all(&payload)?;
        f.write_all(checksum.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, sidecar_path(db_path, program_key))?;
    Ok(())
}

/// Load a pin. `None` on ANY irregularity (missing file, wrong magic, bad checksum,
/// short read, malformed payload) — the caller then evaluates from scratch.
pub fn load(db_path: &Path, program_key: u64) -> Option<PinSidecar> {
    let mut f = std::fs::File::open(sidecar_path(db_path, program_key)).ok()?;
    let mut magic = [0u8; 8];
    f.read_exact(&mut magic).ok()?;
    if &magic != MAGIC {
        return None;
    }
    let mut len_buf = [0u8; 8];
    f.read_exact(&mut len_buf).ok()?;
    let len = u64::from_le_bytes(len_buf) as usize;
    // A pin blob is bounded by the derived-relation sizes; refuse absurd lengths so a
    // corrupt header cannot trigger a giant allocation.
    if len > 8 * 1024 * 1024 * 1024 {
        return None;
    }
    let mut payload = vec![0u8; len];
    f.read_exact(&mut payload).ok()?;
    let mut checksum = [0u8; 32];
    f.read_exact(&mut checksum).ok()?;
    if blake3::hash(&payload).as_bytes() != &checksum {
        return None;
    }

    let mut cur = &payload[..];
    let version = read_u64(&mut cur)?;
    let mut tombstone_hash = [0u8; 32];
    read_bytes(&mut cur, &mut tombstone_hash)?;
    let evaluation = decode_evaluation(&mut cur)?;
    if !cur.is_empty() {
        return None; // trailing garbage ⇒ treat as corrupt
    }
    Some(PinSidecar { version, tombstone_hash, evaluation })
}

/// Remove a program's sidecar (used when a run is NOT persistable, so a stale older pin
/// cannot linger). Missing file is fine.
pub fn remove(db_path: &Path, program_key: u64) {
    let _ = std::fs::remove_file(sidecar_path(db_path, program_key));
}

// ── Evaluation (de)serialization: a simple length-prefixed binary layout ──
//
// relations: u32 count, then per relation: name (u32 len + bytes), u64 row count, per
// row: u8 arity, per value: tag byte + payload (0=Id/u128le, 1=Str/u32len+bytes,
// 2=Int/i64le, 3=Float/f64le-bits).

fn encode_evaluation(eval: &Evaluation, out: &mut Vec<u8>) {
    out.extend_from_slice(&(eval.relations.len() as u32).to_le_bytes());
    for (name, rows) in &eval.relations {
        out.extend_from_slice(&(name.len() as u32).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(rows.len() as u64).to_le_bytes());
        for row in rows {
            out.push(row.len() as u8);
            for v in row.iter() {
                match v {
                    Value::Id(id) => {
                        out.push(0);
                        out.extend_from_slice(&id.to_le_bytes());
                    }
                    Value::Str(s) => {
                        out.push(1);
                        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
                        out.extend_from_slice(s.as_bytes());
                    }
                    Value::Int(i) => {
                        out.push(2);
                        out.extend_from_slice(&i.to_le_bytes());
                    }
                    Value::Float(fl) => {
                        out.push(3);
                        out.extend_from_slice(&fl.to_bits().to_le_bytes());
                    }
                }
            }
        }
    }
}

fn decode_evaluation(cur: &mut &[u8]) -> Option<Evaluation> {
    let n_rel = read_u32(cur)? as usize;
    let mut relations: BTreeMap<String, Vec<Box<[Value]>>> = BTreeMap::new();
    for _ in 0..n_rel {
        let name_len = read_u32(cur)? as usize;
        let name = String::from_utf8(take(cur, name_len)?.to_vec()).ok()?;
        let n_rows = read_u64(cur)? as usize;
        let mut rows: Vec<Box<[Value]>> = Vec::with_capacity(n_rows.min(1 << 20));
        for _ in 0..n_rows {
            let arity = read_u8(cur)? as usize;
            let mut row: Vec<Value> = Vec::with_capacity(arity);
            for _ in 0..arity {
                let tag = read_u8(cur)?;
                row.push(match tag {
                    0 => Value::Id(u128::from_le_bytes(take(cur, 16)?.try_into().ok()?)),
                    1 => {
                        let len = read_u32(cur)? as usize;
                        Value::Str(String::from_utf8(take(cur, len)?.to_vec()).ok()?)
                    }
                    2 => Value::Int(i64::from_le_bytes(take(cur, 8)?.try_into().ok()?)),
                    3 => Value::Float(f64::from_bits(u64::from_le_bytes(
                        take(cur, 8)?.try_into().ok()?,
                    ))),
                    _ => return None,
                });
            }
            rows.push(row.into_boxed_slice());
        }
        relations.insert(name, rows);
    }
    Some(Evaluation { relations })
}

fn take<'a>(cur: &mut &'a [u8], n: usize) -> Option<&'a [u8]> {
    if cur.len() < n {
        return None;
    }
    let (head, rest) = cur.split_at(n);
    *cur = rest;
    Some(head)
}

fn read_u8(cur: &mut &[u8]) -> Option<u8> {
    Some(take(cur, 1)?[0])
}

fn read_u32(cur: &mut &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(take(cur, 4)?.try_into().ok()?))
}

fn read_u64(cur: &mut &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(take(cur, 8)?.try_into().ok()?))
}

fn read_bytes(cur: &mut &[u8], out: &mut [u8]) -> Option<()> {
    out.copy_from_slice(take(cur, out.len())?);
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn sample_eval() -> Evaluation {
        let mut relations: BTreeMap<String, Vec<Box<[Value]>>> = BTreeMap::new();
        relations.insert(
            "depends".to_string(),
            vec![
                vec![Value::Id(42), Value::Id(7)].into_boxed_slice(),
                vec![Value::Str("a".into()), Value::Int(-3), Value::Float(1.5)]
                    .into_boxed_slice(),
            ],
        );
        relations.insert("empty_rel".to_string(), vec![]);
        Evaluation { relations }
    }

    /// save → load round-trips the exact evaluation + state key.
    #[test]
    fn sidecar_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), 0xDEAD_BEEF, 99, &[7u8; 32], &sample_eval()).unwrap();
        let loaded = load(dir.path(), 0xDEAD_BEEF).expect("loads back");
        assert_eq!(loaded.version, 99);
        assert_eq!(loaded.tombstone_hash, [7u8; 32]);
        assert_eq!(loaded.evaluation, sample_eval());
    }

    /// A flipped payload byte fails the checksum ⇒ `None` (scratch), never a misparse.
    #[test]
    fn corrupt_sidecar_loads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), 5, 1, &[0u8; 32], &sample_eval()).unwrap();
        let path = dir.path().join(SIDECAR_DIR).join(format!("{:016x}.pin", 5u64));
        let mut bytes = std::fs::read(&path).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xFF;
        std::fs::write(&path, bytes).unwrap();
        assert!(load(dir.path(), 5).is_none());
        // And a missing file is also a clean miss.
        assert!(load(dir.path(), 6).is_none());
    }

    /// The tombstone hash is a pure function of set CONTENT (insertion order must not
    /// matter), and any content change changes it.
    #[test]
    fn tombstone_hash_is_content_keyed() {
        let mut a = TombstoneSet::new();
        a.node_ids.insert(1);
        a.node_ids.insert(2);
        a.edge_keys.insert((1, 2, Arc::from("CALLS")));
        let mut b = TombstoneSet::new();
        b.edge_keys.insert((1, 2, Arc::from("CALLS")));
        b.node_ids.insert(2);
        b.node_ids.insert(1);
        assert_eq!(tombstone_hash(&a), tombstone_hash(&b));

        b.node_ids.insert(3);
        assert_ne!(tombstone_hash(&a), tombstone_hash(&b));

        // Edge-key content matters too (the un-tombstone path removes edge keys).
        let mut c = TombstoneSet::new();
        c.node_ids.insert(1);
        c.node_ids.insert(2);
        assert_ne!(tombstone_hash(&a), tombstone_hash(&c));
    }

    /// Read/write disjointness: constant disjoint types pass; reading a written type,
    /// a VARIABLE type position, and a WILDCARD type position all refuse.
    #[test]
    fn read_write_disjointness_gate() {
        use crate::derive::parser_ext::parse_ext_program;
        let spec = |t: &str| MaterializeSpec {
            predicate: "p".into(),
            edge_type: t.into(),
            rule_ast_hash: "h".into(),
            additive: false,
            meta: Vec::new(),
        };

        let prog = parse_ext_program(r#"p(A, B) :- edge(A, B, "IMPORTS_FROM")."#).unwrap();
        assert!(!program_reads_written_edge_types(&prog.rules(), &[spec("DEPENDS_ON")]));

        let prog = parse_ext_program(r#"p(A, B) :- edge(A, B, "DEPENDS_ON")."#).unwrap();
        assert!(program_reads_written_edge_types(&prog.rules(), &[spec("DEPENDS_ON")]));

        let prog = parse_ext_program(r#"p(A, B) :- edge(A, B, T), neq(T, "x")."#).unwrap();
        assert!(program_reads_written_edge_types(&prog.rules(), &[spec("DEPENDS_ON")]));

        let prog = parse_ext_program(r#"p(A, B) :- edge(A, B, _), node(B, "MODULE")."#).unwrap();
        assert!(program_reads_written_edge_types(&prog.rules(), &[spec("DEPENDS_ON")]));

        // incoming/edge_attr read edges too.
        let prog = parse_ext_program(r#"p(A, B) :- incoming(A, B, "DEPENDS_ON")."#).unwrap();
        assert!(program_reads_written_edge_types(&prog.rules(), &[spec("DEPENDS_ON")]));
    }
}
