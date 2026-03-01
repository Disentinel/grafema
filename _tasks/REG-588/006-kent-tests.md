# REG-588: Kent Beck Test Report — substring_match

## Summary

6 Rust tests written for the `substring_match` feature in `FindByAttr`. All 6 pass on first run.

No TypeScript tests added — existing TS test coverage for `find_nodes` is concurrency-focused, not parameter-level. The Rust tests cover the actual matching logic which is the critical path.

## Tests Written

**File:** `packages/rfdb-server/src/bin/rfdb_server.rs` (protocol_tests module)

### Test 1: `test_find_by_attr_name_substring`
- Adds node with name `"handleFooBar"` (type FUNCTION)
- Queries with `name: "Foo", substring_match: true`
- Asserts: 1 result (substring match works for name field)
- **PASS**

### Test 2: `test_find_by_attr_file_substring`
- Adds node with file `"src/controllers/userController.ts"`
- Queries with `file: "controllers/user", substring_match: true`
- Asserts: 1 result (substring match works for file field)
- **PASS**

### Test 3: `test_find_by_attr_exact_default`
- Adds node with name `"handleFooBar"`
- Query 1: `name: "Foo", substring_match: false` -> 0 results (exact match fails for partial)
- Query 2: `name: "handleFooBar", substring_match: false` -> 1 result (exact match succeeds)
- Verifies default behavior (exact match) is preserved
- **PASS**

### Test 4: `test_find_by_attr_empty_query_no_match_all`
- Adds 3 nodes: 2 FUNCTION + 1 VARIABLE
- Queries with `node_type: "FUNCTION", name: "", substring_match: true`
- Asserts: 2 results (empty string = no filter on name, type filter still applies)
- Verifies the `!f.is_empty()` guard works correctly
- **PASS**

### Test 5: `test_find_by_attr_substring_no_false_positives`
- Adds 2 nodes: `"fooBar"` (id 1) and `"bazQux"` (id 2)
- Queries with `name: "foo", substring_match: true`
- Asserts: exactly 1 result, and it is node id "1"
- Verifies no false positives from unrelated names
- **PASS**

### Test 6: `test_find_by_attr_substring_after_flush`
- Adds node, flushes to segment (data moves from write buffer to on-disk)
- Query 1: `name: "User", substring_match: true` after flush -> 1 result
- Query 2: `file: "services/user", substring_match: true` after flush -> 1 result
- Verifies zone map bypass works correctly for flushed segments
- **PASS**

## Test Run Output

```
running 6 tests
test protocol_tests::test_find_by_attr_name_substring ... ok
test protocol_tests::test_find_by_attr_file_substring ... ok
test protocol_tests::test_find_by_attr_empty_query_no_match_all ... ok
test protocol_tests::test_find_by_attr_exact_default ... ok
test protocol_tests::test_find_by_attr_substring_no_false_positives ... ok
test protocol_tests::test_find_by_attr_substring_after_flush ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 60 filtered out
```

## Coverage Analysis

| Aspect | Covered |
|--------|---------|
| Name substring matching | Yes (test 1, 5) |
| File substring matching | Yes (test 2, 6) |
| Exact match default preserved | Yes (test 3) |
| Empty string guard (`!f.is_empty()`) | Yes (test 4) |
| No false positives | Yes (test 5) |
| Post-flush (zone map bypass) | Yes (test 6) |
| Both name AND file substring simultaneously | Partially (test 6 tests them separately on same node) |

## Notes

- All tests follow existing `protocol_tests` patterns: ephemeral DB setup, `WireNode` construction, `handle_request` + `Response::Ids` matching.
- Tests are inserted between `test_find_by_attr_with_metadata_filters` and `test_declare_fields_command` in the test module.
- No implementation code was modified.
