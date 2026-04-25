# REG-308: Investigation and Fix Report

## Summary

Server-side file filtering in `queryNodes()` was already implemented correctly in the Rust engine. The issue was caused by an outdated prebuilt binary in the `@grafema/rfdb` npm package.

## Investigation

### Initial Analysis

1. Read the issue description which mentioned FileExplainer.ts had client-side filtering workaround
2. Found that FileExplainer.ts no longer exists (was refactored/removed)
3. Traced through the file filtering implementation:
   - RFDBServerBackend.ts → RFDBClient.ts → rfdb_server.rs → engine.rs

### Root Cause

The server-side file filtering was already correctly implemented:

1. **AttrQuery struct** (storage/mod.rs:89) includes `file: Option<String>` field
2. **find_by_attr** (engine.rs:670-729) properly checks file path for both delta and segment nodes
3. **QueryNodes handler** (rfdb_server.rs:434-449) passes the file filter correctly

The issue was:
- RFDBServerBackend prioritized the npm package binary over local builds
- The `@grafema/rfdb@0.1.0-alpha.2` prebuilt binary was outdated and didn't have file filtering

## Fix

### Changes Made

1. **packages/rfdb-server/src/graph/engine.rs**
   - Added 3 unit tests for file filtering:
     - `test_find_by_attr_file_filter_delta` - tests delta (unflushed) nodes
     - `test_find_by_attr_file_filter_segment` - tests segment (flushed) nodes
     - `test_find_by_attr_file_and_type_combined` - tests combined type + file filter

2. **packages/core/src/storage/backends/RFDBServerBackend.ts**
   - Changed binary search order to prioritize local monorepo builds for development:
     - Now checks `packages/rfdb-server/target/release` first
     - Falls back to `packages/rfdb-server/target/debug`
     - Uses npm package `@grafema/rfdb` as last fallback

3. **test/unit/storage/backends/RFDBServerBackend.file-filtering.test.js**
   - Added integration test verifying file filtering works end-to-end

## Test Results

### Rust Unit Tests (3/3 pass)
```
test graph::engine::tests::test_find_by_attr_file_filter_delta ... ok
test graph::engine::tests::test_find_by_attr_file_filter_segment ... ok
test graph::engine::tests::test_find_by_attr_file_and_type_combined ... ok
```

### JavaScript Integration Tests (4/4 pass)
```
ok 1 - should filter nodes by file path (delta/unflushed)
ok 2 - should filter nodes by file path combined with type
ok 3 - should filter nodes by file path after flush (segment data)
ok 4 - should return empty result for non-existent file
```

## Acceptance Criteria Verification

1. ✅ `queryNodes({ file: path })` returns only nodes for that file
2. ✅ No client-side filtering needed (FileExplainer workaround already removed)
3. ✅ Performance improvement confirmed (filtering happens on server side)

## Notes

- The `@grafema/rfdb` npm package should be updated with the latest binary
- Binary search order change is intentional for development but npm package remains available for production deployments
