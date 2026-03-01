# Revised Plan: REG-588 — Server-side substring matching

**Based on:** Don's plan (002) + Dijkstra's verification (003)

## Approach

Add `substring_match: bool` (default `false`) to `WireAttrQuery` and `AttrQuery`. When `true`, `name` and `file` fields use `.contains()` (substring) instead of `==` (exact). MCP `handleFindNodes` passes `substringMatch: true`. All existing callers unchanged (default `false` = exact match).

## Changes

### 1. `AttrQuery` — add field (`storage/mod.rs:88`)

```rust
pub struct AttrQuery {
    // ... existing fields ...
    #[serde(default)]
    pub substring_match: bool,
}
```

`AttrQuery` already derives `Default` — `bool` defaults to `false`. All existing struct construction sites (rfdb_server.rs:1021, 1206, 1592, 1994) must add `substring_match: query.substring_match` or use `..Default::default()`.

### 2. `WireAttrQuery` — add field (`rfdb_server.rs:~614`)

```rust
pub struct WireAttrQuery {
    // ... existing fields ...
    #[serde(default, rename = "substringMatch")]
    pub substring_match: bool,
}
```

`#[serde(default)]` is REQUIRED — without it, existing JS clients that don't send the field will fail deserialization.

### 3. `matches_attr_filters` in `shard.rs` — add param

```rust
fn matches_attr_filters(
    // ... existing params ...
    substring_match: bool,
) -> bool {
    // ...
    if let Some(f) = file {
        if substring_match {
            if !f.is_empty() && !file_value.contains(f) {
                return false;
            }
        } else if file_value != f {
            return false;
        }
    }
    if let Some(n) = name {
        if substring_match {
            if !n.is_empty() && !name_value.contains(n) {
                return false;
            }
        } else if name_value != n {
            return false;
        }
    }
    // ...
}
```

**Empty string guard:** `!f.is_empty()` / `!n.is_empty()` prevents `"anything".contains("") == true` from matching everything.

### 4. `find_node_ids_by_attr` in `shard.rs` — thread param, fix zone map

Add `substring_match: bool` parameter. When `true`, skip file-based zone map pruning at BOTH levels:

**Descriptor-level (current):**
```rust
if let Some(nt) = node_type {
    if !desc.may_contain(Some(nt), file, None) { continue; }
} else if !desc.may_contain(None, file, None) { continue; }
```
**After (when `substring_match=true`):**
```rust
let prune_file = if substring_match { None } else { file };
if let Some(nt) = node_type {
    if !desc.may_contain(Some(nt), prune_file, None) { continue; }
} else if !desc.may_contain(None, prune_file, None) { continue; }
```

**Segment-level:** Same approach — skip `seg.contains_file(f)` when `substring_match=true`.

Pass `substring_match` to all `matches_attr_filters` calls.

### 5. `multi_shard.rs` — thread param

`MultiShard::find_node_ids_by_attr` delegates to `Shard::find_node_ids_by_attr`. Thread `substring_match` from `AttrQuery`.

### 6. `engine_v2.rs` — thread from `AttrQuery`

`GraphEngineV2::find_by_attr` extracts fields from `AttrQuery` and calls storage. Pass `query.substring_match`.

### 7. `rfdb_server.rs` — 4 handler sites

Thread `substring_match` from `WireAttrQuery` → `AttrQuery` at:
- `FindByAttr` handler (~line 1021)
- `QueryNodes` handler (~line 1206)
- `handle_query_nodes_streaming` (~line 1994)
- `CommitBatch` handler (~line 1592) — uses `file` for deletion, always exact, set `substring_match: false`

### 8. `query-handlers.ts` — clean up MCP handler

```typescript
const filter: Record<string, unknown> = {};
if (type) filter.type = type;
if (name) filter.name = name;
if (file) filter.file = file;
filter.substringMatch = true;

for await (const node of db.queryNodes(filter)) {
    // No client-side name/file filtering needed
    totalMatched++;
    // ... pagination logic unchanged ...
}
```

### 9. v1 engine — NO CHANGES

`database_manager.rs:create_database` always creates `GraphEngineV2`. The v1 `GraphEngine` is only used in tests. Not reachable from the server protocol. `AttrQuery` gains the field (via `Default`) but v1 `find_by_attr` ignores it — safe because v1 is never called with `substring_match=true`.

## Tests

**Rust (shard.rs or engine_v2.rs test section):**
1. `test_find_by_attr_name_substring` — name `"handleFooBar"` found by `"Foo"` with `substring_match=true`
2. `test_find_by_attr_file_substring` — file `"src/foo/bar.ts"` found by `"foo/bar"` with `substring_match=true`
3. `test_find_by_attr_exact_default` — default `substring_match=false` preserves exact matching
4. `test_find_by_attr_empty_query_no_match_all` — empty `name: ""` with `substring_match=true` doesn't return everything
5. `test_find_by_attr_substring_in_flushed_segment` — works after segment flush (zone map bypass)

**TypeScript (test/unit/):**
1. Integration test: `handleFindNodes` with substring name returns correct nodes

## Files Changed

| File | Change |
|------|--------|
| `packages/rfdb-server/src/storage/mod.rs` | Add `substring_match: bool` to `AttrQuery` |
| `packages/rfdb-server/src/storage_v2/shard.rs` | Thread `substring_match` through `matches_attr_filters` and `find_node_ids_by_attr`, add empty-string guard, skip file zone-map prune |
| `packages/rfdb-server/src/storage_v2/multi_shard.rs` | Thread `substring_match` |
| `packages/rfdb-server/src/graph/engine_v2.rs` | Thread from `AttrQuery` to storage |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | Add field to `WireAttrQuery`, thread in 4 handlers |
| `packages/mcp/src/handlers/query-handlers.ts` | Pass name/file/substringMatch to server, remove client-side filtering |
