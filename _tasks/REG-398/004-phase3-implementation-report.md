# REG-398 Phase 3: Implementation Report

## Summary

Extended `findByAttr` wire protocol to support metadata field filtering. Clients can now pass arbitrary key-value pairs (e.g. `{ nodeType: "CALL", object: "express" }`) and the server will filter nodes by matching against their metadata JSON.

## Changes

### Modified: `packages/rfdb-server/src/storage/mod.rs`
- Added `metadata_filters: Vec<(String, String)>` field to `AttrQuery`
- Added `metadata_filter()` builder method
- Field uses `#[serde(default, skip_serializing_if = "Vec::is_empty")]` for backwards compatibility

### Modified: `packages/rfdb-server/src/bin/rfdb_server.rs`
- Extended `WireAttrQuery` with `#[serde(flatten)] pub extra: HashMap<String, serde_json::Value>`
  - Known fields (`nodeType`, `name`, `file`, `exported`) deserialized as before
  - Any extra fields captured in `extra` map
- Updated `FindByAttr` handler: converts extra fields to `metadata_filters`
- Updated `QueryNodes` handler: same conversion
- Added 1 protocol test: `test_find_by_attr_with_metadata_filters`

### Modified: `packages/rfdb-server/src/graph/engine.rs`
- Added `GraphEngine::metadata_matches()` helper method
  - Parses metadata JSON, checks all (key, value) pairs match
  - Supports string, boolean, and number value matching
  - Returns false if metadata is missing/empty/invalid
- Updated `find_by_attr()` delta search: applies metadata filter after column-based checks
- Updated `find_by_attr()` segment search: applies metadata filter as last check (after all column-based filters)
- Added 4 integration tests:
  - `test_metadata_matches_helper` — unit test for the helper
  - `test_find_by_attr_metadata_filter_delta` — delta nodes with metadata
  - `test_find_by_attr_metadata_filter_segment` — segment nodes after flush
  - `test_find_by_attr_metadata_filter_without_type` — metadata-only filter (no nodeType)

### Modified: `packages/types/src/rfdb.ts`
- Added index signature `[key: string]: string | boolean | number | undefined` to `AttrQuery`

## Design Decisions

1. **Metadata filters placed LAST in filter chain**: Column-based filters (type, name, file, exported) are checked first. Metadata parsing is only done on candidates that pass all other checks. This minimizes JSON parsing cost.

2. **String comparison for all value types**: Wire protocol sends typed JSON values; server converts to strings for comparison against metadata JSON values. This is simple and covers the common cases (string, bool, number).

3. **AND semantics**: All metadata filters must match. This matches the existing behavior where all AttrQuery fields are ANDed.

4. **Backwards compatible**: Empty `extra` map = no metadata filtering = same behavior as before.

## Test Results

230 tests pass:
- 199 unit tests (including 4 new metadata filter tests)
- 21 protocol tests (including 1 new metadata filter test)
- 10 doc tests (2 ignored)

## Complexity Analysis

- **Metadata parsing**: O(1) per node (JSON parse of small metadata string)
- **Filter chain**: metadata check only applied to nodes that pass all column-based filters
- **No extra iteration**: piggybacks on existing find_by_attr scan
- **Wire protocol**: zero overhead when no extra fields sent (empty HashMap)
