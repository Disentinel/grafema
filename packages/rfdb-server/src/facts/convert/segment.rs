//! The converted store's fact-segment codec (P6 stage 1; ledger round-012-pre
//! F1/Q1).
//!
//! A NEW container with a NEW magic — deliberately NOT a third
//! `storage_v2::SegmentType` variant (types.rs:84-96 stays closed; opening it is
//! stage 2's engine change, and keeping the storage_v2 diff at zero is the
//! perf-proxy exemption proof). The layout mirrors the §3.2 «выживает без
//! изменений» conventions: columnar cells, a per-segment string table for
//! interned `Str` values, bloom over the Id-typed leading key column only, and a
//! zone map (min/max leading-key canon bytes) surfaced in the descriptor.
//!
//! One physical row = ONE ASSERTION of a fact (variant A row shape, §6.3): the
//! tuple cells plus perspective/author/tick/semiring/tag/tx columns. A fact with
//! two live assertions occupies two adjacent rows (rows are written pre-sorted
//! by the run's key columns, then full tuple canon bytes, then (author, tick)).
//! Stage 1 supersedes nothing: `tx_created` = 0, `tx_invalidated` = `TX_OPEN`,
//! every tag is Bool — the columns exist so the format does not need to change
//! when stage 2+ writes real values.

use std::io::Write;

use sha2::{Digest, Sha256};

use crate::datalog::{TermBlob, Value};
use crate::derive::canon::{canon_bytes, push_varint};
use crate::derive::tag::{TagV2, TX_OPEN};
use crate::storage_v2::types::BOOLTAG_SEMIRING_ID;

/// Magic + version prefix of every fact segment.
pub const SEG_MAGIC: &[u8; 8] = b"ROFLSEG1";
/// Cell marker for an interned string (followed by a u32 LE string-table index);
/// any other first byte is a canon-v1 tag and the cell is raw canon bytes.
const CELL_INTERNED_STR: u8 = 0x00;
/// Zone-map hex values are truncated to this many BYTES of canon prefix.
const ZONE_MAP_MAX_BYTES: usize = 48;

/// Forward run marker.
pub const DIR_FWD: u8 = 0;
/// Reverse run marker.
pub const DIR_REV: u8 = 1;

/// One physical row (one assertion of one fact).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhysRow {
    /// The decoded tuple.
    pub tuple: Vec<Value>,
    /// Interned perspective id (manifest perspective table position).
    pub persp: u32,
    /// Interned author id (manifest author table position).
    pub author: u32,
    /// Assertion tick.
    pub tick: u64,
}

/// Segment metadata surfaced into the manifest descriptor.
#[derive(Debug, Clone)]
pub struct SegmentMeta {
    /// Physical row count.
    pub rows: u64,
    /// File length in bytes.
    pub bytes: u64,
    /// Zone map minimum (hex of leading key column canon bytes, truncated).
    pub zone_min_hex: String,
    /// Zone map maximum.
    pub zone_max_hex: String,
    /// Bloom probe count when built (Id-typed leading key column only).
    pub bloom_k: Option<u8>,
    /// Bloom bit count when built.
    pub bloom_m_bits: Option<u32>,
    /// sha256 of the file bytes.
    pub sha256: String,
}

/// A typed segment codec error.
#[derive(Debug, Clone)]
pub struct SegmentError(pub String);

impl std::fmt::Display for SegmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "segment codec: {}", self.0)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Canonical Str order (shortlex = LEB128(len) lex, then bytes) — the same
/// order `cmp_len_prefixed` defines for canon Str values.
pub fn canon_str_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn leb(mut x: u64) -> ([u8; 10], usize) {
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
    let (ab, alen) = leb(a.len() as u64);
    let (bb, blen) = leb(b.len() as u64);
    ab[..alen]
        .cmp(&bb[..blen])
        .then_with(|| a.as_bytes().cmp(b.as_bytes()))
}

/// Encode one segment file into bytes + metadata. `leading_col` is the run's
/// key_cols[0] (zone map + bloom source). Rows must arrive pre-sorted.
pub fn encode_segment(
    pred_id: u32,
    direction: u8,
    arity: u8,
    rows: &[PhysRow],
    leading_col: usize,
) -> Result<(Vec<u8>, SegmentMeta), SegmentError> {
    // String table: every top-level Str cell value, unique, canon-str-sorted.
    let mut strings: Vec<&str> = rows
        .iter()
        .flat_map(|r| r.tuple.iter())
        .filter_map(|v| match v {
            Value::Str(s) => Some(s.as_str()),
            _ => None,
        })
        .collect();
    strings.sort_by(|a, b| canon_str_cmp(a, b));
    strings.dedup();
    let index_of = |s: &str| -> u32 {
        strings
            .binary_search_by(|probe| canon_str_cmp(probe, s))
            .expect("string interned above") as u32
    };

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(SEG_MAGIC);
    out.extend_from_slice(&1u32.to_le_bytes()); // format version
    out.extend_from_slice(&pred_id.to_le_bytes());
    out.push(direction);
    out.push(arity);
    out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    // String table.
    out.extend_from_slice(&(strings.len() as u32).to_le_bytes());
    for s in &strings {
        push_varint(&mut out, s.len() as u64);
        out.extend_from_slice(s.as_bytes());
    }
    // Value columns, column-major.
    for col in 0..arity as usize {
        for row in rows {
            let v = row.tuple.get(col).ok_or_else(|| {
                SegmentError(format!("row arity below declared {arity} at column {col}"))
            })?;
            match v {
                Value::Str(s) => {
                    out.push(CELL_INTERNED_STR);
                    out.extend_from_slice(&index_of(s).to_le_bytes());
                }
                other => {
                    canon_bytes(other, &mut out)
                        .map_err(|e| SegmentError(format!("non-canonical cell: {e}")))?;
                }
            }
        }
    }
    // Assertion columns, column-major. Stage 1 writes the Bool/TX constants;
    // the columns are real format surface (variant A row shape).
    for row in rows {
        out.extend_from_slice(&row.persp.to_le_bytes());
    }
    for row in rows {
        out.extend_from_slice(&row.author.to_le_bytes());
    }
    for row in rows {
        out.extend_from_slice(&row.tick.to_le_bytes());
    }
    for _ in rows {
        out.extend_from_slice(&BOOLTAG_SEMIRING_ID.to_le_bytes());
    }
    let bool_tag = TagV2::bool_one();
    for _ in rows {
        push_varint(&mut out, bool_tag.bytes.len() as u64);
        out.extend_from_slice(&bool_tag.bytes);
    }
    for _ in rows {
        out.extend_from_slice(&0u64.to_le_bytes()); // tx_created
    }
    for _ in rows {
        out.extend_from_slice(&TX_OPEN.to_le_bytes()); // tx_invalidated
    }
    // Bloom over the leading key column, Id-typed only (§3.2: a non-hash key
    // would silently degrade FPR; every stage-1 Id IS a BLAKE3-derived u128).
    let all_ids = !rows.is_empty()
        && rows
            .iter()
            .all(|r| matches!(r.tuple.get(leading_col), Some(Value::Id(_))));
    let (bloom_k, bloom_m_bits) = if all_ids {
        let m_bits: u32 = ((rows.len() as u64) * 10)
            .next_power_of_two()
            .max(64)
            .min(1 << 26) as u32;
        let mut bits = vec![0u8; (m_bits as usize).div_ceil(8)];
        for row in rows {
            if let Some(Value::Id(x)) = row.tuple.get(leading_col) {
                let hi = ((x >> 64) as u64) % u64::from(m_bits);
                let lo = (*x as u64) % u64::from(m_bits);
                for pos in [hi, lo] {
                    bits[(pos / 8) as usize] |= 1 << (pos % 8);
                }
            }
        }
        out.push(1u8);
        out.push(2u8); // k
        out.extend_from_slice(&m_bits.to_le_bytes());
        out.extend_from_slice(&bits);
        (Some(2u8), Some(m_bits))
    } else {
        out.push(0u8);
        (None, None)
    };

    let zone = |row: &PhysRow| -> Result<String, SegmentError> {
        let mut b = Vec::new();
        match &row.tuple[leading_col] {
            Value::Str(s) => {
                // Zone values use the canonical encoding regardless of the
                // interned cell representation.
                canon_bytes(&Value::Str(s.clone()), &mut b)
            }
            other => canon_bytes(other, &mut b),
        }
        .map_err(|e| SegmentError(format!("non-canonical zone key: {e}")))?;
        b.truncate(ZONE_MAP_MAX_BYTES);
        Ok(hex(&b))
    };
    let (zone_min_hex, zone_max_hex) = match (rows.first(), rows.last()) {
        (Some(first), Some(last)) => (zone(first)?, zone(last)?),
        _ => (String::new(), String::new()),
    };

    let mut hasher = Sha256::new();
    hasher.update(&out);
    let meta = SegmentMeta {
        rows: rows.len() as u64,
        bytes: out.len() as u64,
        zone_min_hex,
        zone_max_hex,
        bloom_k,
        bloom_m_bits,
        sha256: hex(&hasher.finalize()),
    };
    Ok((out, meta))
}

/// Write an encoded segment to `path` (plain write; the manifest rename is the
/// store's publish point, round-012-pre F3).
pub fn write_segment(
    path: &std::path::Path,
    pred_id: u32,
    direction: u8,
    arity: u8,
    rows: &[PhysRow],
    leading_col: usize,
) -> Result<SegmentMeta, SegmentError> {
    let (bytes, meta) = encode_segment(pred_id, direction, arity, rows, leading_col)?;
    let mut f = std::fs::File::create(path)
        .map_err(|e| SegmentError(format!("create {}: {e}", path.display())))?;
    f.write_all(&bytes)
        .map_err(|e| SegmentError(format!("write {}: {e}", path.display())))?;
    Ok(meta)
}

// ── Decoding (the reader's half) ───────────────────────────────────

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], SegmentError> {
        if self.pos + n > self.bytes.len() {
            return Err(SegmentError("truncated segment".to_string()));
        }
        let s = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, SegmentError> {
        Ok(self.take(1)?[0])
    }

    /// Read the next byte WITHOUT consuming it. Bounds-checked like [`Cursor::take`]:
    /// a truncated segment must surface as a typed [`SegmentError`], never as a
    /// slice-index panic (the reader decodes untrusted on-disk bytes).
    fn peek_u8(&self) -> Result<u8, SegmentError> {
        self.bytes
            .get(self.pos)
            .copied()
            .ok_or_else(|| SegmentError("truncated segment".to_string()))
    }

    fn u16(&mut self) -> Result<u16, SegmentError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, SegmentError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, SegmentError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn varint(&mut self) -> Result<u64, SegmentError> {
        let mut x: u64 = 0;
        let mut shift = 0u32;
        loop {
            let b = self.u8()?;
            x |= u64::from(b & 0x7F) << shift;
            if b & 0x80 == 0 {
                return Ok(x);
            }
            shift += 7;
            if shift > 63 {
                return Err(SegmentError("varint overflow".to_string()));
            }
        }
    }

    /// Decode one canon-v1 value at the cursor (the inverse of `canon_bytes`).
    fn canon_value(&mut self) -> Result<Value, SegmentError> {
        let tag = self.u8()?;
        match tag {
            0x01 => Ok(Value::Id(u128::from_be_bytes(
                self.take(16)?.try_into().unwrap(),
            ))),
            0x02 => {
                let len = self.varint()? as usize;
                let s = std::str::from_utf8(self.take(len)?)
                    .map_err(|e| SegmentError(format!("non-UTF8 Str payload: {e}")))?;
                Ok(Value::Str(s.to_string()))
            }
            0x03 => Ok(Value::Int(i64::from_be_bytes(
                self.take(8)?.try_into().unwrap(),
            ))),
            0x04 => Ok(Value::Float(f64::from_bits(u64::from_be_bytes(
                self.take(8)?.try_into().unwrap(),
            )))),
            0x05 => {
                let len = self.varint()? as usize;
                Ok(Value::BigInt(self.take(len)?.to_vec().into()))
            }
            0x06 => {
                let flen = self.varint()? as usize;
                let functor = std::str::from_utf8(self.take(flen)?)
                    .map_err(|e| SegmentError(format!("non-UTF8 functor: {e}")))?
                    .to_string();
                let argc = self.varint()? as usize;
                let mut args = Vec::with_capacity(argc);
                for _ in 0..argc {
                    args.push(self.canon_value()?);
                }
                let blob = TermBlob::new(functor, args)
                    .map_err(|e| SegmentError(format!("non-canonical Term: {e}")))?;
                Ok(Value::Term(std::sync::Arc::new(blob)))
            }
            other => Err(SegmentError(format!("unknown canon tag 0x{other:02x}"))),
        }
    }
}

/// A decoded segment.
#[derive(Debug)]
pub struct DecodedSegment {
    /// Owning predicate id.
    pub pred_id: u32,
    /// [`DIR_FWD`] | [`DIR_REV`].
    pub direction: u8,
    /// Declared arity.
    pub arity: u8,
    /// The physical rows, in stored order.
    pub rows: Vec<PhysRow>,
}

/// Decode a segment file.
pub fn read_segment(path: &std::path::Path) -> Result<DecodedSegment, SegmentError> {
    let bytes = std::fs::read(path)
        .map_err(|e| SegmentError(format!("read {}: {e}", path.display())))?;
    let mut c = Cursor {
        bytes: &bytes,
        pos: 0,
    };
    if c.take(8)? != SEG_MAGIC {
        return Err(SegmentError(format!("bad magic in {}", path.display())));
    }
    let version = c.u32()?;
    if version != 1 {
        return Err(SegmentError(format!("unknown segment format {version}")));
    }
    let pred_id = c.u32()?;
    let direction = c.u8()?;
    let arity = c.u8()?;
    let row_count = c.u32()? as usize;
    let string_count = c.u32()? as usize;
    let mut strings = Vec::with_capacity(string_count);
    for _ in 0..string_count {
        let len = c.varint()? as usize;
        strings.push(
            std::str::from_utf8(c.take(len)?)
                .map_err(|e| SegmentError(format!("non-UTF8 table string: {e}")))?
                .to_string(),
        );
    }
    // Value columns.
    let mut columns: Vec<Vec<Value>> = Vec::with_capacity(arity as usize);
    for _ in 0..arity {
        let mut col = Vec::with_capacity(row_count);
        for _ in 0..row_count {
            let marker = c.peek_u8()?;
            if marker == CELL_INTERNED_STR {
                c.pos += 1;
                let idx = c.u32()? as usize;
                let s = strings
                    .get(idx)
                    .ok_or_else(|| SegmentError(format!("string index {idx} out of range")))?;
                col.push(Value::Str(s.clone()));
            } else {
                col.push(c.canon_value()?);
            }
        }
        columns.push(col);
    }
    // Assertion columns.
    let mut persp = Vec::with_capacity(row_count);
    for _ in 0..row_count {
        persp.push(c.u32()?);
    }
    let mut author = Vec::with_capacity(row_count);
    for _ in 0..row_count {
        author.push(c.u32()?);
    }
    let mut tick = Vec::with_capacity(row_count);
    for _ in 0..row_count {
        tick.push(c.u64()?);
    }
    for _ in 0..row_count {
        let semiring = c.u16()?;
        if semiring != BOOLTAG_SEMIRING_ID {
            return Err(SegmentError(format!(
                "stage-1 segment carries non-Bool semiring {semiring}"
            )));
        }
    }
    let bool_tag = TagV2::bool_one();
    for _ in 0..row_count {
        let len = c.varint()? as usize;
        let tag_bytes = c.take(len)?;
        if tag_bytes != &bool_tag.bytes[..] {
            return Err(SegmentError("stage-1 segment carries non-Bool tag".to_string()));
        }
    }
    for _ in 0..row_count {
        if c.u64()? != 0 {
            return Err(SegmentError("stage-1 tx_created must be 0".to_string()));
        }
    }
    for _ in 0..row_count {
        if c.u64()? != TX_OPEN {
            return Err(SegmentError("stage-1 tx_invalidated must be TX_OPEN".to_string()));
        }
    }
    // Bloom section (validated for shape, not consumed by the reader).
    let bloom_flag = c.u8()?;
    if bloom_flag == 1 {
        let _k = c.u8()?;
        let m_bits = c.u32()?;
        let _ = c.take((m_bits as usize).div_ceil(8))?;
    }
    if c.pos != c.bytes.len() {
        return Err(SegmentError(format!(
            "trailing garbage: {} of {} bytes consumed",
            c.pos,
            c.bytes.len()
        )));
    }

    let mut rows = Vec::with_capacity(row_count);
    for i in 0..row_count {
        rows.push(PhysRow {
            tuple: columns.iter().map(|col| col[i].clone()).collect(),
            persp: persp[i],
            author: author[i],
            tick: tick[i],
        });
    }
    Ok(DecodedSegment {
        pred_id,
        direction,
        arity,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;
    use std::sync::Arc;

    fn term(functor: &str, args: Vec<Value>) -> Value {
        Value::Term(Arc::new(
            TermBlob::new(functor, args).expect("canonical term"),
        ))
    }

    fn row(tuple: Vec<Value>, persp: u32, author: u32, tick: u64) -> PhysRow {
        PhysRow {
            tuple,
            persp,
            author,
            tick,
        }
    }

    /// Nine rows, arity 2, leading column Id(1..=9) already in canon order, second
    /// column covering every stage-1 value shape plus a repeated Str (interning).
    fn shape_rows() -> Vec<PhysRow> {
        vec![
            row(vec![Value::Id(1), Value::Str("alpha".into())], 0, 0, 7),
            row(vec![Value::Id(2), Value::Int(-42)], 0, 1, 8),
            row(
                vec![
                    Value::Id(3),
                    Value::big_int_from_decimal("18446744073709551615").expect("u64::MAX bigint"),
                ],
                0,
                1,
                9,
            ),
            row(vec![Value::Id(4), Value::float(1.5)], 1, 2, 0),
            row(vec![Value::Id(5), term("$true", vec![])], 0, 0, 3),
            row(vec![Value::Id(6), Value::Id(0xdead_beef)], 0, 2, 4),
            row(
                vec![
                    Value::Id(7),
                    term("$json", vec![Value::Str("{\"a\":1}".into())]),
                ],
                0,
                0,
                5,
            ),
            row(vec![Value::Id(8), Value::Str("shared".into())], 0, 1, 6),
            row(vec![Value::Id(9), Value::Str("shared".into())], 1, 1, 6),
        ]
    }

    fn write_tmp(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("seg.bin");
        std::fs::write(&path, bytes).expect("write segment bytes");
        (dir, path)
    }

    fn count_occurrences(haystack: &[u8], needle: &[u8]) -> usize {
        if needle.is_empty() || haystack.len() < needle.len() {
            return 0;
        }
        (0..=haystack.len() - needle.len())
            .filter(|i| &haystack[*i..*i + needle.len()] == needle)
            .count()
    }

    #[test]
    fn encode_read_round_trip_preserves_rows_shapes_and_assertion_columns() {
        let rows = shape_rows();
        let (bytes, meta) = encode_segment(77, DIR_FWD, 2, &rows, 0).expect("encode");
        assert_eq!(meta.rows, rows.len() as u64);
        assert_eq!(meta.bytes, bytes.len() as u64);

        // Interning: the repeated Str payload appears ONCE in the byte stream,
        // and the string table holds exactly the distinct top-level Str cells
        // ("alpha", "shared") — the Str nested inside the $json Term is canon,
        // not interned.
        assert_eq!(
            count_occurrences(&bytes, b"shared"),
            1,
            "repeated Str must be interned once"
        );
        let string_count = u32::from_le_bytes(bytes[22..26].try_into().unwrap());
        assert_eq!(string_count, 2, "only top-level Str cells are interned");
        assert_eq!(
            count_occurrences(&bytes, b"{\"a\":1}"),
            1,
            "the Term-nested Str is written once, inline"
        );

        let (_dir, path) = write_tmp(&bytes);
        let seg = read_segment(&path).expect("decode");
        assert_eq!(seg.pred_id, 77);
        assert_eq!(seg.direction, DIR_FWD);
        assert_eq!(seg.arity, 2);
        // Rows, value TYPES, assertion columns and ORDER all survive verbatim.
        assert_eq!(seg.rows, rows);
        assert!(matches!(seg.rows[2].tuple[1], Value::BigInt(_)));
        assert!(matches!(seg.rows[3].tuple[1], Value::Float(_)));
        assert!(matches!(seg.rows[4].tuple[1], Value::Term(_)));
        assert!(matches!(seg.rows[5].tuple[1], Value::Id(_)));
        assert_eq!(
            seg.rows.iter().map(|r| r.tick).collect::<Vec<_>>(),
            vec![7, 8, 9, 0, 3, 4, 5, 6, 6]
        );
        assert_eq!(
            seg.rows.iter().map(|r| (r.persp, r.author)).collect::<Vec<_>>(),
            vec![(0, 0), (0, 1), (0, 1), (1, 2), (0, 0), (0, 2), (0, 0), (0, 1), (1, 1)]
        );

        // A reverse-direction segment keeps its marker.
        let (rbytes, _) = encode_segment(77, DIR_REV, 2, &rows, 0).expect("encode rev");
        let (_d2, p2) = write_tmp(&rbytes);
        assert_eq!(read_segment(&p2).expect("decode rev").direction, DIR_REV);
    }

    #[test]
    fn corrupt_magic_wrong_version_and_trailing_bytes_are_typed_errors() {
        let rows = shape_rows();
        let (good, _) = encode_segment(3, DIR_FWD, 2, &rows, 0).expect("encode");

        let mut bad_magic = good.clone();
        bad_magic[0] ^= 0xFF;
        let (_d, p) = write_tmp(&bad_magic);
        let e = read_segment(&p).expect_err("bad magic must be rejected");
        assert!(e.0.contains("bad magic"), "unexpected error: {}", e.0);

        let mut bad_version = good.clone();
        bad_version[8..12].copy_from_slice(&2u32.to_le_bytes());
        let (_d, p) = write_tmp(&bad_version);
        let e = read_segment(&p).expect_err("format 2 must be rejected");
        assert!(
            e.0.contains("unknown segment format 2"),
            "unexpected error: {}",
            e.0
        );

        let mut trailing = good.clone();
        trailing.push(0x00);
        let (_d, p) = write_tmp(&trailing);
        let e = read_segment(&p).expect_err("trailing bytes must be rejected");
        assert!(
            e.0.contains("trailing garbage"),
            "unexpected error: {}",
            e.0
        );

        // A row-count that disagrees with the payload is a length mismatch, not a
        // silent short read.
        let mut wrong_rows = good.clone();
        wrong_rows[18..22].copy_from_slice(&((rows.len() as u32) - 1).to_le_bytes());
        let (_d, p) = write_tmp(&wrong_rows);
        assert!(
            read_segment(&p).is_err(),
            "row-count mismatch must be an error"
        );
    }

    #[test]
    fn every_truncation_is_a_typed_error_never_a_panic() {
        let rows = shape_rows();
        let (good, _) = encode_segment(5, DIR_FWD, 2, &rows, 0).expect("encode");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cut.bin");
        for cut in 0..good.len() {
            std::fs::write(&path, &good[..cut]).expect("write prefix");
            assert!(
                read_segment(&path).is_err(),
                "prefix of {cut}/{} bytes decoded as a valid segment",
                good.len()
            );
        }
        std::fs::write(&path, &good).expect("write full");
        assert!(read_segment(&path).is_ok(), "the full segment still decodes");
    }

    #[test]
    fn bloom_has_no_false_negatives_and_still_rejects_absent_keys() {
        let rows: Vec<PhysRow> = (0..64u128)
            .map(|i| {
                row(
                    vec![
                        Value::Id(0x1000_0000_0000_0000_0000_0000_0000_0000u128 + i * 7919),
                        Value::Int(i as i64),
                    ],
                    0,
                    0,
                    1,
                )
            })
            .collect();
        let (bytes, meta) = encode_segment(9, DIR_FWD, 2, &rows, 0).expect("encode");
        let k = meta.bloom_k.expect("Id leading column builds a bloom");
        let m_bits = meta.bloom_m_bits.expect("bloom bit count");
        assert_eq!(k, 2);

        // Parse the bloom section back off the tail of the encoded bytes.
        let bits_len = (m_bits as usize).div_ceil(8);
        let n = bytes.len();
        assert_eq!(bytes[n - bits_len - 6], 1u8, "bloom flag");
        assert_eq!(bytes[n - bits_len - 5], 2u8, "bloom k");
        assert_eq!(
            u32::from_le_bytes(bytes[n - bits_len - 4..n - bits_len].try_into().unwrap()),
            m_bits
        );
        let bits = &bytes[n - bits_len..];
        let probe = |x: u128| -> bool {
            let hi = ((x >> 64) as u64) % u64::from(m_bits);
            let lo = (x as u64) % u64::from(m_bits);
            [hi, lo]
                .iter()
                .all(|pos| bits[(*pos / 8) as usize] & (1 << (*pos % 8)) != 0)
        };

        // No false NEGATIVE: every present key probes positive.
        for r in &rows {
            let Value::Id(x) = r.tuple[0] else {
                unreachable!()
            };
            assert!(probe(x), "bloom false negative for present key {x}");
        }
        // Non-vacuity: an all-ones filter would pass the above trivially, so most
        // absent keys must be REJECTED.
        let mut state: u128 = 0xdead_beef_cafe_babe;
        let mut rejected = 0usize;
        for _ in 0..512 {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            if !probe(state) {
                rejected += 1;
            }
        }
        assert!(
            rejected >= 256,
            "bloom rejected only {rejected}/512 absent keys — filter is near-saturated"
        );

        // A non-Id leading column builds no bloom at all (§3.2).
        let str_rows = vec![
            row(vec![Value::Str("a".into()), Value::Int(1)], 0, 0, 1),
            row(vec![Value::Str("b".into()), Value::Int(2)], 0, 0, 1),
        ];
        let (sbytes, smeta) = encode_segment(9, DIR_FWD, 2, &str_rows, 0).expect("encode str");
        assert!(smeta.bloom_k.is_none());
        assert!(smeta.bloom_m_bits.is_none());
        assert_eq!(*sbytes.last().expect("bloom flag byte"), 0u8);
    }

    #[test]
    fn zone_map_min_max_bound_the_leading_column() {
        fn canon_hex(v: &Value) -> String {
            let mut b = Vec::new();
            canon_bytes(v, &mut b).expect("canon");
            b.truncate(ZONE_MAP_MAX_BYTES);
            b.iter().map(|x| format!("{x:02x}")).collect()
        }

        let rows = shape_rows();
        let (_bytes, meta) = encode_segment(1, DIR_FWD, 2, &rows, 0).expect("encode");
        assert_eq!(meta.zone_min_hex, canon_hex(&rows[0].tuple[0]));
        assert_eq!(meta.zone_max_hex, canon_hex(&rows[rows.len() - 1].tuple[0]));
        // Every row's leading key really lies inside [min, max] (canon bytes of
        // equal-length Id cells compare as hex strings do).
        for r in &rows {
            let h = canon_hex(&r.tuple[0]);
            assert!(h >= meta.zone_min_hex, "{h} below zone min");
            assert!(h <= meta.zone_max_hex, "{h} above zone max");
        }

        // Str leading column: the zone map uses the CANONICAL encoding even though
        // the cell itself is interned, so a key sorting outside the range can be
        // ruled out by the descriptor alone.
        let str_rows = vec![
            row(vec![Value::Str("aa".into()), Value::Int(1)], 0, 0, 1),
            row(vec![Value::Str("mm".into()), Value::Int(2)], 0, 0, 1),
            row(vec![Value::Str("zz".into()), Value::Int(3)], 0, 0, 1),
        ];
        let (_b, smeta) = encode_segment(1, DIR_FWD, 2, &str_rows, 0).expect("encode");
        assert_eq!(smeta.zone_min_hex, canon_hex(&Value::Str("aa".into())));
        assert_eq!(smeta.zone_max_hex, canon_hex(&Value::Str("zz".into())));
        assert!(smeta.zone_min_hex.starts_with("02"), "canon Str tag in zone");
        let outside = canon_hex(&Value::Str("zzzzzzzzzzzz".into()));
        assert!(
            outside > smeta.zone_max_hex,
            "a longer key must sort above the zone max under shortlex"
        );
        let below = canon_hex(&Value::Str("a".into()));
        assert!(
            below < smeta.zone_min_hex,
            "a shorter key must sort below the zone min under shortlex"
        );

        // Empty run: no zone bounds at all.
        let (_b, empty) = encode_segment(1, DIR_FWD, 2, &[], 0).expect("encode empty");
        assert_eq!(empty.rows, 0);
        assert_eq!(empty.zone_min_hex, "");
        assert_eq!(empty.zone_max_hex, "");
        assert!(empty.bloom_k.is_none());
    }

    #[test]
    fn canon_str_cmp_is_shortlex_and_agrees_with_the_crate_value_order() {
        // The cases plain lexicographic order gets WRONG.
        assert_eq!(canon_str_cmp("z", "aa"), Ordering::Less);
        assert_eq!("z".cmp("aa"), Ordering::Greater);
        assert_eq!(canon_str_cmp("aa", "z"), Ordering::Greater);
        // UTF-8 multibyte: "é" is 2 bytes, so it sorts AFTER any 1-byte string and
        // BEFORE any 3-byte one — the opposite of byte-lex in both directions.
        assert_eq!(canon_str_cmp("é", "abc"), Ordering::Less);
        assert_eq!("é".cmp("abc"), Ordering::Greater);
        assert_eq!(canon_str_cmp("é", "z"), Ordering::Greater);
        assert_eq!(canon_str_cmp("é", "ab"), Ordering::Greater);
        assert_eq!(canon_str_cmp("é", "é"), Ordering::Equal);
        // Same length falls back to bytewise.
        assert_eq!(canon_str_cmp("abc", "abd"), Ordering::Less);
        assert_eq!(canon_str_cmp("", "a"), Ordering::Less);
        assert_eq!(canon_str_cmp("", ""), Ordering::Equal);

        // Across every LEB128 length boundary, `canon_str_cmp` must equal the
        // crate's canonical `Value::Str` order (which is what segments are sorted
        // by) — including 255 vs 256, where LEB-lex is NOT numeric length order.
        let lens = [0usize, 1, 2, 3, 127, 128, 129, 255, 256, 16383, 16384];
        let samples: Vec<String> = lens.iter().map(|n| "x".repeat(*n)).collect();
        for a in &samples {
            for b in &samples {
                let want = Value::Str(a.clone()).cmp(&Value::Str(b.clone()));
                assert_eq!(
                    canon_str_cmp(a, b),
                    want,
                    "len {} vs len {} disagrees with Value order",
                    a.len(),
                    b.len()
                );
            }
        }
        // Pin the surprising boundary explicitly. The order is LEB128-ENCODING lex
        // on the length, which equals numeric shortlex only while the encodings
        // have equal width: 127 (0x7F) < 128 (0x80 0x01) holds, but 255
        // (0xFF 0x01) > 256 (0x80 0x02) — the LONGER string sorts FIRST there.
        // That is not a defect: `cmp_len_prefixed` (derive/canon.rs:163) defines
        // the canonical Str order the same way, and the matrix above proves the
        // two agree byte-for-byte. Agreement with `Ord for Value` is the
        // load-bearing contract (segment rows are sorted by it); "shortlex" in the
        // doc comment is exact only for lengths whose LEB128 widths match.
        assert_eq!(canon_str_cmp(&samples[4], &samples[5]), Ordering::Less);
        assert_eq!(canon_str_cmp(&samples[7], &samples[8]), Ordering::Greater);
        assert_eq!(
            Value::Str(samples[7].clone()).cmp(&Value::Str(samples[8].clone())),
            Ordering::Greater,
            "the crate's canonical Str order makes the same call"
        );
    }
}
