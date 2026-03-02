# Vadim Review #2 — REG-588 Completeness Review

**Verdict: APPROVE**

---

## Previous Rejection Reason (Resolved)

The original rejection was that `substringMatch` was silently dropped in two places:
1. `RFDBServerBackend.queryNodes` — used a local field allowlist that didn't include `substringMatch`
2. `base-client._buildServerQuery` — same allowlist problem

Both are now fixed.

---

## Integration Pipeline Verification

Tracing `substringMatch` from MCP handler through to Rust:

### 1. MCP handler (`packages/mcp/src/handlers/query-handlers.ts:287`)

```ts
filter.substringMatch = true;
```

Set unconditionally before calling `db.queryNodes(filter)`. Correct.

### 2. GraphDB / core layer (`packages/core/src/storage/backends/RFDBServerBackend.ts:510`)

```ts
if (query.substringMatch) serverQuery.substringMatch = query.substringMatch;
```

`NodeQuery` interface (line 91) now includes `substringMatch?: boolean`. The field is forwarded into `serverQuery` which is passed to `this.client.queryNodes(serverQuery)`.

### 3. base-client `_buildServerQuery` (`packages/rfdb/ts/base-client.ts:325`)

```ts
if (query.substringMatch) serverQuery.substringMatch = query.substringMatch;
```

The old allowlist that blocked unknown fields is gone. `substringMatch` is now an explicit, named field in the output object.

### 4. Wire protocol — serde mapping

`WireAttrQuery` in `rfdb_server.rs` has `#[serde(rename_all = "camelCase")]`:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAttrQuery {
    pub substring_match: bool,   // deserializes from "substringMatch" JSON key
    ...
}
```

TypeScript sends `substringMatch`, Rust receives it as `substring_match`. Mapping is correct.

### 5. `wire_to_attr_query` helper (`rfdb_server.rs:793`)

```rust
fn wire_to_attr_query(query: WireAttrQuery) -> AttrQuery {
    ...
    substring_match: query.substring_match,
}
```

Called at 3 request handlers: `FindByAttr` (line 1040), `QueryNodes` (line 1206), and the streaming path (line 1975). DRY — no duplicate conversion logic.

### 6. `matches_attr_filters` in `shard.rs` (lines 923–961)

```rust
fn matches_attr_filters(..., substring_match: bool) -> bool {
    if let Some(f) = file {
        if substring_match {
            if !f.is_empty() && !file_value.contains(f) { return false; }
        } else if file_value != f { return false; }
    }
    if let Some(n) = name {
        if substring_match {
            if !n.is_empty() && !name_value.contains(n) { return false; }
        } else if name_value != n { return false; }
    }
    ...
}
```

Correct: `.contains()` for substring, exact equality for default. Empty-string guard prevents "match everything" when an empty pattern is passed with `substringMatch: true`.

### 7. Zone map pruning (`shard.rs:1255`)

```rust
let prune_file = if substring_match { None } else { file };
```

Substring queries bypass zone map pruning for the file dimension. This is correct: zone maps store exact paths and cannot evaluate substring predicates. The write buffer and segment scans both flow through `matches_attr_filters` which does the correct substring test.

---

## Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| `matches_attr_filters` uses `.contains()` for name and file when `substring_match: true` | PASS |
| Zone map pruning disabled for substring queries | PASS |
| MCP handler delegates filtering to server via `substringMatch: true` | PASS |
| Exact-match callers unaffected (`substring_match` defaults to `false` via `#[serde(default)]`) | PASS |

---

## DRY Fix (Uncle Bob)

`wire_to_attr_query` is defined once (line 793) and called at all 3 conversion sites (lines 1040, 1206, 1975). No duplicate field-mapping code remains.

---

## Test Coverage

6 Rust tests in `rfdb_server.rs`:

| Test | Covers |
|------|--------|
| `test_find_by_attr_name_substring` | Substring match on name field |
| `test_find_by_attr_file_substring` | Substring match on file field |
| `test_find_by_attr_exact_default` | Default exact match still works |
| `test_find_by_attr_empty_query_no_match_all` | Empty string guard (skips filter) |
| `test_find_by_attr_substring_no_false_positives` | Non-matching nodes are not returned |
| `test_find_by_attr_substring_after_flush` | Substring works on flushed segments (zone map bypass) |

Coverage is adequate. The post-flush test is particularly important — it specifically exercises the zone map bypass path by calling `Request::Flush` before querying.

---

## Summary

All four acceptance criteria are met. The critical pipeline break (fields silently dropped by allowlists in two TypeScript layers) is fixed. The DRY helper is in place. Tests cover the important edge cases including the post-flush segment path. No issues found.
