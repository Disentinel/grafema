//! Bloom filter with key-split enhanced double-hashing.
//!
//! Designed for u128 keys that are already BLAKE3 hashes. Instead of
//! re-hashing, we split the 128-bit key into two 64-bit halves (h1, h2)
//! and use enhanced double-hashing to derive probe positions.
//!
//! Binary format:
//! ```text
//! [num_bits: u64 LE]           // 8 bytes
//! [num_hashes: u32 LE]         // 4 bytes
//! [padding: u32 LE = 0]        // 4 bytes
//! [bits: u64 LE x word_count]  // word_count = ceil(num_bits / 64)
//! ```

use std::io::Write;

use crate::error::{GraphError, Result};
use crate::storage_v2::types::{BLOOM_BITS_PER_KEY, BLOOM_NUM_HASHES};

/// Header size: num_bits(8) + num_hashes(4) + padding(4) = 16 bytes.
const BLOOM_HEADER_SIZE: usize = 16;

/// Bloom filter backed by a bit vector with key-split double-hashing.
#[derive(Debug)]
pub struct BloomFilter {
    bits: Vec<u64>,
    num_bits: usize,
    num_hashes: usize,
}

/// Compute probe positions using key-split enhanced double-hashing.
///
/// The u128 key (already a BLAKE3 hash) is split into two 64-bit halves.
/// h2 is forced odd (RocksDB technique) to ensure it is coprime with any
/// power-of-two modulus, giving better bit distribution.
fn probe_positions(
    key: u128,
    num_hashes: usize,
    num_bits: usize,
) -> impl Iterator<Item = usize> {
    let bytes = key.to_le_bytes();
    let h1 = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let h2 = u64::from_le_bytes(bytes[8..16].try_into().unwrap()) | 1; // ensure odd
    (0..num_hashes as u64)
        .map(move |i| (h1.wrapping_add(i.wrapping_mul(h2)) % (num_bits as u64)) as usize)
}

impl BloomFilter {
    /// Create a new bloom filter sized for `num_keys` expected insertions.
    ///
    /// Uses BLOOM_BITS_PER_KEY (10) and BLOOM_NUM_HASHES (7) from the
    /// segment format constants, giving ~0.82% theoretical FPR.
    ///
    /// The bit count is rounded up to a multiple of 64 (word-aligned) with
    /// a minimum of 64 bits. An empty filter (0 keys) is valid and always
    /// returns false from `maybe_contains`.
    pub fn new(num_keys: usize) -> Self {
        let raw_bits = num_keys.saturating_mul(BLOOM_BITS_PER_KEY);
        let min_bits = raw_bits.max(64);
        // Round up to next multiple of 64.
        let num_bits = (min_bits + 63) & !63;
        let word_count = num_bits / 64;
        Self {
            bits: vec![0u64; word_count],
            num_bits,
            num_hashes: BLOOM_NUM_HASHES,
        }
    }

    /// Insert a u128 key (BLAKE3 hash) into the filter.
    pub fn insert(&mut self, key: u128) {
        for pos in probe_positions(key, self.num_hashes, self.num_bits) {
            let word = pos / 64;
            let bit = pos % 64;
            self.bits[word] |= 1u64 << bit;
        }
    }

    /// Test whether a key might be in the set.
    ///
    /// Returns `false` → definitely not present.
    /// Returns `true`  → probably present (subject to FPR).
    pub fn maybe_contains(&self, key: u128) -> bool {
        for pos in probe_positions(key, self.num_hashes, self.num_bits) {
            let word = pos / 64;
            let bit = pos % 64;
            if self.bits[word] & (1u64 << bit) == 0 {
                return false;
            }
        }
        true
    }

    /// Number of bits in the filter.
    pub fn num_bits(&self) -> usize {
        self.num_bits
    }

    /// Number of hash functions used.
    pub fn num_hashes(&self) -> usize {
        self.num_hashes
    }

    /// Serialize the bloom filter into the writer.
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()> {
        writer.write_all(&(self.num_bits as u64).to_le_bytes())?;
        writer.write_all(&(self.num_hashes as u32).to_le_bytes())?;
        writer.write_all(&0u32.to_le_bytes())?; // padding
        for &word in &self.bits {
            writer.write_all(&word.to_le_bytes())?;
        }
        Ok(())
    }

    /// Deserialize a bloom filter from a byte slice.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < BLOOM_HEADER_SIZE {
            return Err(GraphError::InvalidFormat(
                "Bloom filter too small".into(),
            ));
        }

        let num_bits = u64::from_le_bytes(bytes[0..8].try_into().unwrap()) as usize;
        let num_hashes = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        // bytes[12..16] is padding, ignored on read.

        if num_bits == 0 {
            return Err(GraphError::InvalidFormat(
                "Bloom filter has zero bits".into(),
            ));
        }

        let word_count = (num_bits + 63) / 64;
        let expected_size = BLOOM_HEADER_SIZE + word_count * 8;
        if bytes.len() < expected_size {
            return Err(GraphError::InvalidFormat(
                "Bloom filter data truncated".into(),
            ));
        }

        let mut bits = Vec::with_capacity(word_count);
        for i in 0..word_count {
            let offset = BLOOM_HEADER_SIZE + i * 8;
            let word = u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
            bits.push(word);
        }

        Ok(Self {
            bits,
            num_bits,
            num_hashes,
        })
    }

    /// Total serialized size in bytes.
    pub fn serialized_size(&self) -> usize {
        BLOOM_HEADER_SIZE + self.bits.len() * 8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bloom_empty() {
        let bf = BloomFilter::new(0);
        assert_eq!(bf.num_bits(), 64);
        assert_eq!(bf.num_hashes(), BLOOM_NUM_HASHES);
        // Empty filter: nothing inserted, every query returns false.
        for i in 0u128..100 {
            assert!(!bf.maybe_contains(i), "empty bloom should not contain {}", i);
        }
    }

    #[test]
    fn test_bloom_single_item() {
        let mut bf = BloomFilter::new(1);
        let key: u128 = 0xdeadbeef_cafebabe_12345678_9abcdef0;
        assert!(!bf.maybe_contains(key));
        bf.insert(key);
        assert!(bf.maybe_contains(key));
    }

    #[test]
    fn test_bloom_no_false_negatives() {
        let n = 1000;
        let mut bf = BloomFilter::new(n);
        let keys: Vec<u128> = (0..n as u128).map(|i| {
            // Simulate realistic keys by spreading bits.
            i.wrapping_mul(0x9e3779b97f4a7c15_u128) ^ (i << 64)
        }).collect();

        for &k in &keys {
            bf.insert(k);
        }
        for &k in &keys {
            assert!(bf.maybe_contains(k), "false negative for key {}", k);
        }
    }

    #[test]
    fn test_bloom_roundtrip() {
        let n = 500;
        let mut bf = BloomFilter::new(n);
        let keys: Vec<u128> = (0..n as u128).map(|i| {
            i.wrapping_mul(0x517cc1b727220a95_u128) ^ (i << 64)
        }).collect();

        for &k in &keys {
            bf.insert(k);
        }

        let mut buf = Vec::new();
        bf.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), bf.serialized_size());

        let bf2 = BloomFilter::from_bytes(&buf).unwrap();
        assert_eq!(bf2.num_bits(), bf.num_bits());
        assert_eq!(bf2.num_hashes(), bf.num_hashes());

        for &k in &keys {
            assert!(bf2.maybe_contains(k), "false negative after roundtrip for key {}", k);
        }
    }

    #[test]
    fn test_bloom_serialized_size() {
        // 100 keys * 10 bits/key = 1000 bits, rounded up to 1024 (16 words).
        let bf = BloomFilter::new(100);
        assert_eq!(bf.num_bits(), 1024);
        // Header (16) + 16 words * 8 bytes = 16 + 128 = 144
        assert_eq!(bf.serialized_size(), 16 + 16 * 8);

        let mut buf = Vec::new();
        bf.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), bf.serialized_size());
    }

    #[test]
    fn test_bloom_from_bytes_too_small() {
        let buf = vec![0u8; 12]; // less than 16-byte header
        let err = BloomFilter::from_bytes(&buf).unwrap_err();
        assert!(
            err.to_string().contains("Bloom filter too small"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_bloom_from_bytes_truncated() {
        // Write a valid header claiming 128 bits (2 words) but only provide
        // partial data for the bit array.
        let mut buf = Vec::new();
        buf.extend_from_slice(&128u64.to_le_bytes()); // num_bits = 128
        buf.extend_from_slice(&7u32.to_le_bytes());   // num_hashes = 7
        buf.extend_from_slice(&0u32.to_le_bytes());   // padding
        // Need 2 * 8 = 16 bytes of bit data, only provide 8.
        buf.extend_from_slice(&0u64.to_le_bytes());

        let err = BloomFilter::from_bytes(&buf).unwrap_err();
        assert!(
            err.to_string().contains("Bloom filter data truncated"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_bloom_from_bytes_zero_bits() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u64.to_le_bytes());  // num_bits = 0
        buf.extend_from_slice(&7u32.to_le_bytes());  // num_hashes
        buf.extend_from_slice(&0u32.to_le_bytes());  // padding

        let err = BloomFilter::from_bytes(&buf).unwrap_err();
        assert!(
            err.to_string().contains("Bloom filter has zero bits"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_bloom_fpr_under_2_percent() {
        let n = 10_000;
        let mut bf = BloomFilter::new(n);

        // Insert n keys.
        for i in 0..n as u128 {
            let key = i.wrapping_mul(0x9e3779b97f4a7c15_u128) ^ (i << 64);
            bf.insert(key);
        }

        // Test 100_000 keys that were NOT inserted.
        let test_count = 100_000u128;
        let mut false_positives = 0u64;
        let offset = n as u128 + 1_000_000; // well outside inserted range
        for i in 0..test_count {
            let key = (i + offset).wrapping_mul(0x517cc1b727220a95_u128) ^ ((i + offset) << 64);
            if bf.maybe_contains(key) {
                false_positives += 1;
            }
        }

        let fpr = false_positives as f64 / test_count as f64;
        assert!(
            fpr < 0.02,
            "FPR too high: {:.4}% ({} false positives out of {})",
            fpr * 100.0,
            false_positives,
            test_count
        );
    }
}
