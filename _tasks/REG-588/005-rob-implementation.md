# Implementation Report: REG-588 — Server-side substring matching

## Summary

Added `substring_match: bool` flag to RFDB's `find_by_attr` pipeline. When `true`, `name` and `file` filters use `.contains()` (substring) instead of `==` (exact match). MCP `handleFindNodes` now passes `substringMatch: true` and delegates all filtering to the server, removing client-side filtering.

## Files Changed

### 1. `packages/rfdb-server/src/storage/mod.rs`
- Added `substring_match: bool` field to `AttrQuery` struct with `#[serde(default)]`

### 2. `packages/rfdb-server/src/storage_v2/shard.rs`
- Added `substring_match: bool` parameter to `matches_attr_filters()`
- Changed `file` and `name` matching to use `.contains()` when `substring_match=true`
- Added empty-string guard (`!f.is_empty()` / `!n.is_empty()`) to prevent empty string matching everything
- Added `substring_match: bool` parameter to `find_node_ids_by_attr()`
- Added `prune_file` variable: skips file-based zone map pruning at both descriptor and segment level when `substring_match=true`
- Threaded `substring_match` to both `matches_attr_filters` call sites

### 3. `packages/rfdb-server/src/storage_v2/multi_shard.rs`
- Added `substring_match: bool` parameter to `find_node_ids_by_attr()`
- Threaded to per-shard `find_node_ids_by_attr()` calls

### 4. `packages/rfdb-server/src/graph/engine_v2.rs`
- Threaded `query.substring_match` to `store.find_node_ids_by_attr()` in `find_by_attr()`
- Passed `false` in `find_by_type()` (always exact match)

### 5. `packages/rfdb-server/src/bin/rfdb_server.rs`
- Added `substring_match: bool` field to `WireAttrQuery` with `#[serde(default)]`
  - Note: `WireAttrQuery` uses `#[serde(rename_all = "camelCase")]`, so the JSON field name is `substringMatch`
- Threaded `query.substring_match` in 3 handlers: FindByAttr, QueryNodes, streaming QueryNodes
- Set `substring_match: false` explicitly in CommitBatch handler (file deletion always exact)
- Added `substring_match: false` to all 10 test `WireAttrQuery` struct literals

### 6. `packages/rfdb-server/src/ffi/napi_bindings.rs`
- Updated 2 `AttrQuery` struct constructions to use `..Default::default()` (covers new field)

### 7. `packages/mcp/src/handlers/query-handlers.ts`
- `handleFindNodes`: now passes `name`, `file`, and `substringMatch: true` to server
- Removed client-side `if (name && ...)` and `if (file && ...)` substring filtering
- Pagination logic unchanged
