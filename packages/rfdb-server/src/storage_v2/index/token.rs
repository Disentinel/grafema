//! Token-based fuzzy name index for RFDB.
//!
//! When exact `find_nodes(name=...)` returns 0 results, this index enables
//! fuzzy fallback: split names into tokens (CamelCase, snake_case, dots,
//! hyphens), compute Jaccard similarity, and return ranked matches.
//!
//! # Example
//!
//! Searching `"PtyHostHeartbeatService"` will match `"HeartbeatService"`
//! because they share the tokens `["heartbeat", "service"]`.
//!
//! # Binary Format
//!
//! ```text
//! [Header: 20 bytes]
//!   magic: b"RTOK" (4 bytes)
//!   version: u32 = 1 (4 bytes)
//!   token_count: u32 (4 bytes)
//!   entry_count: u32 (4 bytes)
//!   name_count: u32 (4 bytes)
//!
//! [Token String Table]
//!   total_len: u32
//!   bytes: concatenated lowercase token strings
//!
//! [Token Lookup Table: sorted by token for binary search]
//!   Per token (12 bytes each):
//!     token_offset: u32
//!     token_len: u16
//!     _padding: u16
//!     entry_offset: u32
//!
//! [Entry Table]
//!   Per entry (4 bytes each):
//!     name_index: u32
//!
//! [Name Table]
//!   Per name (20 bytes + variable):
//!     node_id: u128
//!     name_len: u32
//!   Followed by concatenated name strings (UTF-8)
//! ```

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};

use crate::error::{GraphError, Result};
use crate::storage_v2::types::NodeRecordV2;

// ── Constants ──────────────────────────────────────────────────────

/// Magic bytes for token index files.
const TOKEN_INDEX_MAGIC: [u8; 4] = *b"RTOK";

/// Token index format version.
const TOKEN_INDEX_VERSION: u32 = 1;

// ── Tokenizer ──────────────────────────────────────────────────────

/// Split a name into lowercase tokens by CamelCase boundaries, underscores,
/// hyphens, and dots. Single-character tokens and empty strings are filtered.
///
/// # CamelCase rules
///
/// - Transition lowercase->uppercase starts new token: `heartB` -> `["heart", "b..."]`
/// - Run of uppercase before lowercase: `HTTPClient` -> `["http", "client"]`
/// - All-uppercase stays together until next lowercase: `getHTTPSUrl` -> `["get", "https", "url"]`
///
/// # Examples
///
/// ```text
/// "PtyHostHeartbeatService" -> ["pty", "host", "heartbeat", "service"]
/// "get_user_by_id"          -> ["get", "user", "by", "id"]
/// "HTTPClient"              -> ["http", "client"]
/// "parseJSON"               -> ["parse", "json"]
/// "XMLParser"               -> ["xml", "parser"]
/// "getHTTPSUrl"             -> ["get", "https", "url"]
/// "MyClass.method"          -> ["my", "class", "method"]
/// "a"                       -> []  (single char filtered)
/// ""                        -> []
/// ```
pub fn tokenize_name(name: &str) -> Vec<String> {
    let mut raw_tokens: Vec<String> = Vec::new();
    let mut current = String::new();

    let chars: Vec<char> = name.chars().collect();
    let len = chars.len();

    let mut i = 0;
    while i < len {
        let c = chars[i];

        // Separators: underscore, hyphen, dot
        if c == '_' || c == '-' || c == '.' {
            if !current.is_empty() {
                raw_tokens.push(std::mem::take(&mut current));
            }
            i += 1;
            continue;
        }

        if c.is_uppercase() {
            // Check if this starts a run of uppercase chars
            let mut upper_run_end = i + 1;
            while upper_run_end < len && chars[upper_run_end].is_uppercase() {
                upper_run_end += 1;
            }
            let upper_run_len = upper_run_end - i;

            if upper_run_len == 1 {
                // Single uppercase: standard CamelCase boundary
                // e.g., "heartB" -> flush "heart", start "B"
                if !current.is_empty() {
                    raw_tokens.push(std::mem::take(&mut current));
                }
                current.push(c);
            } else {
                // Multiple uppercase chars in a row (acronym)
                if !current.is_empty() {
                    raw_tokens.push(std::mem::take(&mut current));
                }

                // Check if the char after the uppercase run is lowercase
                // If so, the last uppercase char belongs to the NEXT token
                if upper_run_end < len && chars[upper_run_end].is_lowercase() {
                    // e.g., "HTTPClient" -> "HTTP" ends at upper_run_end-1, "C" starts next
                    for j in i..upper_run_end - 1 {
                        current.push(chars[j]);
                    }
                    raw_tokens.push(std::mem::take(&mut current));
                    // Start next token with last uppercase char
                    current.push(chars[upper_run_end - 1]);
                } else {
                    // All uppercase until end or next separator
                    // e.g., "ABC" -> "ABC"
                    for j in i..upper_run_end {
                        current.push(chars[j]);
                    }
                }

                i = upper_run_end;
                continue;
            }
        } else {
            // Lowercase, digit, or other
            current.push(c);
        }

        i += 1;
    }

    if !current.is_empty() {
        raw_tokens.push(current);
    }

    // Lowercase all tokens and filter single-char / empty
    raw_tokens
        .into_iter()
        .map(|t| t.to_lowercase())
        .filter(|t| t.len() > 1)
        .collect()
}

// ── TokenMatch ─────────────────────────────────────────────────────

/// A fuzzy search result from the token index.
pub struct TokenMatch {
    /// Node ID (BLAKE3 hash of semantic_id).
    pub node_id: u128,
    /// Original name of the matched node.
    pub name: String,
    /// Jaccard similarity score (0.0 to 1.0).
    pub score: f32,
}

// ── TokenIndex ─────────────────────────────────────────────────────

/// Token-based fuzzy name index, loaded from binary format.
///
/// Provides Jaccard-similarity search over tokenized node names.
/// Tokens are derived from CamelCase, snake_case, dot, and hyphen
/// boundaries.
#[derive(Debug)]
pub struct TokenIndex {
    /// Token -> indices into `names` array.
    token_to_entries: HashMap<String, Vec<usize>>,
    /// (node_id, original_name) pairs.
    names: Vec<(u128, String)>,
}

impl TokenIndex {
    /// Deserialize a token index from binary format.
    ///
    /// See module-level docs for the binary layout.
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);

        // ── Header (20 bytes) ──
        let mut header_buf = [0u8; 20];
        cursor.read_exact(&mut header_buf).map_err(|e| {
            GraphError::InvalidFormat(format!("Failed to read token index header: {}", e))
        })?;

        let mut magic = [0u8; 4];
        magic.copy_from_slice(&header_buf[0..4]);
        if magic != TOKEN_INDEX_MAGIC {
            return Err(GraphError::InvalidFormat(format!(
                "Not a token index: expected RTOK, got {:?}",
                magic
            )));
        }

        let version = u32::from_le_bytes(header_buf[4..8].try_into().unwrap());
        if version != TOKEN_INDEX_VERSION {
            return Err(GraphError::InvalidFormat(format!(
                "Unsupported token index version: {}",
                version
            )));
        }

        let token_count = u32::from_le_bytes(header_buf[8..12].try_into().unwrap()) as usize;
        let entry_count = u32::from_le_bytes(header_buf[12..16].try_into().unwrap()) as usize;
        let name_count = u32::from_le_bytes(header_buf[16..20].try_into().unwrap()) as usize;

        // ── Token String Table ──
        let mut total_len_buf = [0u8; 4];
        cursor.read_exact(&mut total_len_buf).map_err(|e| {
            GraphError::InvalidFormat(format!(
                "Failed to read token string table length: {}",
                e
            ))
        })?;
        let total_len = u32::from_le_bytes(total_len_buf) as usize;

        let mut token_string_table = vec![0u8; total_len];
        if total_len > 0 {
            cursor.read_exact(&mut token_string_table).map_err(|e| {
                GraphError::InvalidFormat(format!("Failed to read token string table: {}", e))
            })?;
        }

        // ── Token Lookup Table (12 bytes per token) ──
        struct TokenLookup {
            token_offset: u32,
            token_len: u16,
            entry_offset: u32,
        }

        let mut token_lookups = Vec::with_capacity(token_count);
        for _ in 0..token_count {
            let mut buf = [0u8; 12];
            cursor.read_exact(&mut buf).map_err(|e| {
                GraphError::InvalidFormat(format!("Failed to read token lookup entry: {}", e))
            })?;
            token_lookups.push(TokenLookup {
                token_offset: u32::from_le_bytes(buf[0..4].try_into().unwrap()),
                token_len: u16::from_le_bytes(buf[4..6].try_into().unwrap()),
                // buf[6..8] is padding
                entry_offset: u32::from_le_bytes(buf[8..12].try_into().unwrap()),
            });
        }

        // ── Entry Table (4 bytes per entry) ──
        let mut entries = Vec::with_capacity(entry_count);
        for _ in 0..entry_count {
            let mut buf = [0u8; 4];
            cursor.read_exact(&mut buf).map_err(|e| {
                GraphError::InvalidFormat(format!("Failed to read entry table entry: {}", e))
            })?;
            entries.push(u32::from_le_bytes(buf) as usize);
        }

        // ── Name Table ──
        let mut names = Vec::with_capacity(name_count);
        let mut name_strings_data = Vec::new();
        // First pass: read fixed-size records (20 bytes each)
        struct NameHeader {
            node_id: u128,
            name_len: u32,
        }
        let mut name_headers = Vec::with_capacity(name_count);
        for _ in 0..name_count {
            let mut buf = [0u8; 20];
            cursor.read_exact(&mut buf).map_err(|e| {
                GraphError::InvalidFormat(format!("Failed to read name table entry: {}", e))
            })?;
            name_headers.push(NameHeader {
                node_id: u128::from_le_bytes(buf[0..16].try_into().unwrap()),
                name_len: u32::from_le_bytes(buf[16..20].try_into().unwrap()),
            });
        }

        // Read concatenated name strings
        let total_name_bytes: usize = name_headers.iter().map(|h| h.name_len as usize).sum();
        if total_name_bytes > 0 {
            name_strings_data.resize(total_name_bytes, 0);
            cursor.read_exact(&mut name_strings_data).map_err(|e| {
                GraphError::InvalidFormat(format!("Failed to read name strings: {}", e))
            })?;
        }

        let mut offset = 0;
        for header in &name_headers {
            let end = offset + header.name_len as usize;
            let name_str = std::str::from_utf8(&name_strings_data[offset..end]).map_err(|e| {
                GraphError::InvalidFormat(format!("Invalid UTF-8 in name table: {}", e))
            })?;
            names.push((header.node_id, name_str.to_string()));
            offset = end;
        }

        // ── Build token_to_entries map ──
        let mut token_to_entries: HashMap<String, Vec<usize>> = HashMap::new();

        for (i, lookup) in token_lookups.iter().enumerate() {
            let tok_start = lookup.token_offset as usize;
            let tok_end = tok_start + lookup.token_len as usize;
            let token =
                std::str::from_utf8(&token_string_table[tok_start..tok_end]).map_err(|e| {
                    GraphError::InvalidFormat(format!("Invalid UTF-8 in token table: {}", e))
                })?;

            // Determine entry range: from this token's entry_offset to the next token's
            let entry_start = lookup.entry_offset as usize;
            let entry_end = if i + 1 < token_lookups.len() {
                token_lookups[i + 1].entry_offset as usize
            } else {
                entry_count
            };

            let name_indices: Vec<usize> = entries[entry_start..entry_end].to_vec();
            token_to_entries.insert(token.to_string(), name_indices);
        }

        Ok(Self {
            token_to_entries,
            names,
        })
    }

    /// Fuzzy search for names matching the query.
    ///
    /// 1. Tokenize query
    /// 2. For each query token, look up candidate name indices
    /// 3. Compute Jaccard similarity for each candidate
    /// 4. Filter by `min_score`, sort descending, take top `k`
    pub fn search(&self, query: &str, k: usize, min_score: f32) -> Vec<TokenMatch> {
        let query_tokens: HashSet<String> = tokenize_name(query).into_iter().collect();
        if query_tokens.is_empty() {
            return Vec::new();
        }

        // Collect candidate name indices from all matching tokens
        let mut candidate_indices: HashSet<usize> = HashSet::new();
        for token in &query_tokens {
            if let Some(indices) = self.token_to_entries.get(token) {
                for &idx in indices {
                    candidate_indices.insert(idx);
                }
            }
        }

        // Score each candidate
        let mut matches: Vec<TokenMatch> = Vec::new();
        for idx in candidate_indices {
            let (node_id, ref name) = self.names[idx];
            let name_tokens: HashSet<String> = tokenize_name(name).into_iter().collect();

            let intersection = query_tokens.intersection(&name_tokens).count();
            let union = query_tokens.union(&name_tokens).count();

            if union == 0 {
                continue;
            }

            let score = intersection as f32 / union as f32;
            if score >= min_score {
                matches.push(TokenMatch {
                    node_id,
                    name: name.clone(),
                    score,
                });
            }
        }

        // Sort by score descending, then by name for stability
        matches.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        });

        matches.truncate(k);
        matches
    }

    /// Number of distinct tokens in the index.
    pub fn token_count(&self) -> usize {
        self.token_to_entries.len()
    }

    /// Number of indexed (node_id, name) pairs.
    pub fn name_count(&self) -> usize {
        self.names.len()
    }
}

// ── Builder ────────────────────────────────────────────────────────

/// Build and serialize a token index from node records.
///
/// Only records with non-empty names are indexed. The `_shard_id` and
/// `_segment_id` parameters exist for API consistency with
/// `build_inverted_indexes()` but are not stored in the token index.
pub fn build_token_index(
    records: &[NodeRecordV2],
    _shard_id: u16,
    _segment_id: u64,
) -> Result<Vec<u8>> {
    // ── Step 1: Collect unique (node_id, name) pairs ──
    let mut names: Vec<(u128, String)> = Vec::new();
    let mut name_index_map: HashMap<(u128, String), usize> = HashMap::new();

    for record in records {
        if record.name.is_empty() {
            continue;
        }
        let key = (record.id, record.name.clone());
        if !name_index_map.contains_key(&key) {
            let idx = names.len();
            names.push((record.id, record.name.clone()));
            name_index_map.insert(key, idx);
        }
    }

    // ── Step 2: Build token -> name indices map ──
    let mut token_to_indices: HashMap<String, Vec<usize>> = HashMap::new();

    for (i, (_node_id, name)) in names.iter().enumerate() {
        let tokens = tokenize_name(name);
        for token in tokens {
            token_to_indices.entry(token).or_default().push(i);
        }
    }

    // Deduplicate entries per token
    for indices in token_to_indices.values_mut() {
        indices.sort_unstable();
        indices.dedup();
    }

    // ── Step 3: Sort tokens for binary search ──
    let mut sorted_tokens: Vec<String> = token_to_indices.keys().cloned().collect();
    sorted_tokens.sort();

    let token_count = sorted_tokens.len() as u32;
    let entry_count: u32 = token_to_indices.values().map(|v| v.len() as u32).sum();
    let name_count = names.len() as u32;

    // ── Step 4: Build token string table ──
    let mut token_string_table = Vec::new();
    let mut token_offsets: Vec<(u32, u16)> = Vec::new(); // (offset, len)

    for token in &sorted_tokens {
        let offset = token_string_table.len() as u32;
        let len = token.len() as u16;
        token_string_table.extend_from_slice(token.as_bytes());
        token_offsets.push((offset, len));
    }

    // ── Step 5: Serialize ──
    let mut buf = Cursor::new(Vec::new());

    // Header (20 bytes)
    buf.write_all(&TOKEN_INDEX_MAGIC)?;
    buf.write_all(&TOKEN_INDEX_VERSION.to_le_bytes())?;
    buf.write_all(&token_count.to_le_bytes())?;
    buf.write_all(&entry_count.to_le_bytes())?;
    buf.write_all(&name_count.to_le_bytes())?;

    // Token string table
    buf.write_all(&(token_string_table.len() as u32).to_le_bytes())?;
    buf.write_all(&token_string_table)?;

    // Token lookup table (12 bytes each, sorted)
    let mut entry_offset: u32 = 0;
    for (i, token) in sorted_tokens.iter().enumerate() {
        let (tok_offset, tok_len) = token_offsets[i];
        let indices = &token_to_indices[token];

        buf.write_all(&tok_offset.to_le_bytes())?;
        buf.write_all(&tok_len.to_le_bytes())?;
        buf.write_all(&0u16.to_le_bytes())?; // padding
        buf.write_all(&entry_offset.to_le_bytes())?;

        entry_offset += indices.len() as u32;
    }

    // Entry table (4 bytes each)
    for token in &sorted_tokens {
        let indices = &token_to_indices[token];
        for &idx in indices {
            buf.write_all(&(idx as u32).to_le_bytes())?;
        }
    }

    // Name table: fixed-size headers (20 bytes each)
    for (node_id, name) in &names {
        buf.write_all(&node_id.to_le_bytes())?;
        buf.write_all(&(name.len() as u32).to_le_bytes())?;
    }

    // Name table: concatenated name strings
    for (_node_id, name) in &names {
        buf.write_all(name.as_bytes())?;
    }

    Ok(buf.into_inner())
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_node(name: &str) -> NodeRecordV2 {
        let semantic_id = format!("test->{}", name);
        let hash = blake3::hash(semantic_id.as_bytes());
        let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
        NodeRecordV2 {
            semantic_id,
            id,
            node_type: "FUNCTION".to_string(),
            name: name.to_string(),
            file: "test.rs".to_string(),
            content_hash: 0,
            metadata: String::new(),
        }
    }

    // ── Tokenizer Tests ────────────────────────────────────────────

    #[test]
    fn test_tokenize_camel_case() {
        assert_eq!(
            tokenize_name("PtyHostHeartbeatService"),
            vec!["pty", "host", "heartbeat", "service"]
        );
    }

    #[test]
    fn test_tokenize_heartbeat_service() {
        assert_eq!(
            tokenize_name("HeartbeatService"),
            vec!["heartbeat", "service"]
        );
    }

    #[test]
    fn test_tokenize_snake_case() {
        assert_eq!(
            tokenize_name("get_user_by_id"),
            vec!["get", "user", "by", "id"]
        );
    }

    #[test]
    fn test_tokenize_acronym_http_client() {
        assert_eq!(tokenize_name("HTTPClient"), vec!["http", "client"]);
    }

    #[test]
    fn test_tokenize_acronym_parse_json() {
        assert_eq!(tokenize_name("parseJSON"), vec!["parse", "json"]);
    }

    #[test]
    fn test_tokenize_acronym_xml_parser() {
        assert_eq!(tokenize_name("XMLParser"), vec!["xml", "parser"]);
    }

    #[test]
    fn test_tokenize_acronym_get_https_url() {
        assert_eq!(
            tokenize_name("getHTTPSUrl"),
            vec!["get", "https", "url"]
        );
    }

    #[test]
    fn test_tokenize_dot_separator() {
        assert_eq!(
            tokenize_name("MyClass.method"),
            vec!["my", "class", "method"]
        );
    }

    #[test]
    fn test_tokenize_empty_string() {
        let result: Vec<String> = tokenize_name("");
        assert!(result.is_empty());
    }

    #[test]
    fn test_tokenize_single_char() {
        let result: Vec<String> = tokenize_name("a");
        assert!(result.is_empty());
    }

    #[test]
    fn test_tokenize_all_uppercase_short() {
        assert_eq!(tokenize_name("ABC"), vec!["abc"]);
    }

    #[test]
    fn test_tokenize_with_numbers() {
        assert_eq!(tokenize_name("get2ndItem"), vec!["get2nd", "item"]);
    }

    #[test]
    fn test_tokenize_mixed() {
        assert_eq!(
            tokenize_name("my_HTTPClient_v2"),
            vec!["my", "http", "client", "v2"]
        );
    }

    // ── Build + from_bytes Roundtrip ───────────────────────────────

    #[test]
    fn test_build_and_load_roundtrip() {
        let records = vec![
            make_node("HeartbeatService"),
            make_node("PtyHostHeartbeatService"),
            make_node("get_user_by_id"),
            make_node("HTTPClient"),
        ];

        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        assert_eq!(index.name_count(), 4);
        // Tokens: heartbeat, service, pty, host, get, user, by, id, http, client
        assert!(index.token_count() >= 10);
    }

    #[test]
    fn test_build_empty_records() {
        let records: Vec<NodeRecordV2> = vec![];
        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        assert_eq!(index.name_count(), 0);
        assert_eq!(index.token_count(), 0);
    }

    #[test]
    fn test_build_skips_empty_names() {
        let node = make_node("ValidName");
        let mut empty_node = make_node("");
        empty_node.name = String::new();

        let records = vec![node, empty_node];
        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        assert_eq!(index.name_count(), 1);
    }

    // ── Search Tests ───────────────────────────────────────────────

    #[test]
    fn test_search_fuzzy_heartbeat() {
        let records = vec![
            make_node("HeartbeatService"),
            make_node("PtyHostHeartbeatService"),
            make_node("HTTPClient"),
        ];

        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        let results = index.search("PtyHostHeartbeatService", 10, 0.0);

        // Should find PtyHostHeartbeatService with score 1.0
        assert!(!results.is_empty());
        assert_eq!(results[0].name, "PtyHostHeartbeatService");
        assert!((results[0].score - 1.0).abs() < f32::EPSILON);

        // Should also find HeartbeatService as fuzzy match
        let heartbeat_match = results.iter().find(|m| m.name == "HeartbeatService");
        assert!(heartbeat_match.is_some());
        let hb = heartbeat_match.unwrap();
        // Jaccard: |{heartbeat, service}| / |{pty, host, heartbeat, service}| = 2/4 = 0.5
        assert!((hb.score - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn test_search_exact_match_score_1() {
        let records = vec![make_node("HeartbeatService")];

        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        let results = index.search("HeartbeatService", 10, 0.0);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "HeartbeatService");
        assert!((results[0].score - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn test_search_cross_convention() {
        let records = vec![make_node("get_user_by_id")];

        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        let results = index.search("getUserById", 10, 0.0);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "get_user_by_id");
        // Jaccard: tokens are identical sets -> 1.0
        assert!((results[0].score - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn test_search_min_score_filtering() {
        let records = vec![
            make_node("HeartbeatService"),
            make_node("PtyHostHeartbeatService"),
            make_node("HTTPClient"),
        ];

        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        // With min_score 0.6, only exact/near-exact matches
        let results = index.search("PtyHostHeartbeatService", 10, 0.6);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "PtyHostHeartbeatService");
    }

    #[test]
    fn test_search_k_limit() {
        let records = vec![
            make_node("HeartbeatService"),
            make_node("PtyHostHeartbeatService"),
            make_node("HeartbeatMonitor"),
        ];

        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        let results = index.search("HeartbeatService", 1, 0.0);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "HeartbeatService");
    }

    #[test]
    fn test_search_empty_query() {
        let records = vec![make_node("HeartbeatService")];

        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        let results = index.search("", 10, 0.0);
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_single_char_query() {
        let records = vec![make_node("HeartbeatService")];

        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        // Single char tokenizes to empty -> no results
        let results = index.search("a", 10, 0.0);
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_no_match() {
        let records = vec![make_node("HeartbeatService")];

        let bytes = build_token_index(&records, 0, 1).unwrap();
        let index = TokenIndex::from_bytes(&bytes).unwrap();

        let results = index.search("ZigZagFactory", 10, 0.0);
        assert!(results.is_empty());
    }

    #[test]
    fn test_from_bytes_bad_magic() {
        let mut data = vec![0u8; 20];
        data[0..4].copy_from_slice(b"XXXX");
        let err = TokenIndex::from_bytes(&data).unwrap_err();
        assert!(err.to_string().contains("Not a token index"));
    }

    #[test]
    fn test_from_bytes_truncated() {
        let data = vec![0u8; 10];
        let err = TokenIndex::from_bytes(&data).unwrap_err();
        assert!(err.to_string().contains("Failed to read token index header"));
    }
}
