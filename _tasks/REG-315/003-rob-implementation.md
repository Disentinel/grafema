# REG-315: Rob Pike's Implementation Report - attr_edge() Predicate

## Summary

Successfully implemented `attr_edge(Src, Dst, EdgeType, AttrName, Value)` predicate for Datalog evaluation. This predicate enables querying metadata stored on edges, which is essential for REG-314 Phase 3 (cardinality-based guarantees).

## What Was Implemented

### 1. Tests (TDD - Written First)

Added 7 test cases to `packages/rfdb-server/src/datalog/tests.rs`:

| Test | Description |
|------|-------------|
| `test_eval_attr_edge_basic` | Extracts simple top-level attribute from edge metadata |
| `test_eval_attr_edge_nested_path` | Tests nested path resolution (e.g., "cardinality.scale") |
| `test_eval_attr_edge_constant_match` | Matches attribute against constant value |
| `test_eval_attr_edge_no_metadata` | Edge without metadata returns empty |
| `test_eval_attr_edge_missing_attr` | Missing attribute in metadata returns empty |
| `test_eval_attr_edge_edge_not_found` | Non-existent edge returns empty |
| `test_eval_attr_edge_in_rule` | Integration test using attr_edge in a Datalog rule |

### 2. Implementation

In `packages/rfdb-server/src/datalog/eval.rs`:

1. **Added predicate registration** (line ~181):
```rust
"attr_edge" => self.eval_attr_edge(atom),
```

2. **Implemented `eval_attr_edge()` function** (~90 lines):
   - Validates 5 arguments
   - Parses src_id and dst_id (must be bound constants)
   - Gets edge type (must be constant string)
   - Gets attribute name (must be constant, supports nested paths)
   - Finds matching edge using `get_outgoing_edges()`
   - Parses edge metadata JSON
   - Extracts value using existing `get_metadata_value()` helper
   - Matches against value term (variable/constant/wildcard)

## Design Decisions

1. **Follows `eval_attr()` pattern exactly** - consistent with existing codebase style
2. **Reuses `get_metadata_value()` helper** - no code duplication, nested path support comes free
3. **All parameters except Value must be bound** - same constraint as `eval_attr()`, simplifies implementation
4. **Returns first matching edge** - handles edge case of multiple edges with same (src, dst, type)

## Test Results

```
running 95 tests
...
test datalog::tests::eval_tests::test_eval_attr_edge_basic ... ok
test datalog::tests::eval_tests::test_eval_attr_edge_constant_match ... ok
test datalog::tests::eval_tests::test_eval_attr_edge_edge_not_found ... ok
test datalog::tests::eval_tests::test_eval_attr_edge_in_rule ... ok
test datalog::tests::eval_tests::test_eval_attr_edge_missing_attr ... ok
test datalog::tests::eval_tests::test_eval_attr_edge_nested_path ... ok
test datalog::tests::eval_tests::test_eval_attr_edge_no_metadata ... ok
...
test result: ok. 95 passed; 0 failed; 0 ignored
```

All 95 datalog tests pass, including the 7 new tests for `attr_edge()`.

## Files Changed

1. `packages/rfdb-server/src/datalog/eval.rs`:
   - Added `"attr_edge"` to predicate match (line ~181)
   - Added `eval_attr_edge()` function (~90 lines after `eval_attr()`)

2. `packages/rfdb-server/src/datalog/tests.rs`:
   - Added 7 test functions (~500 lines)

## Usage Example

```datalog
% Find loops iterating over large collections
large_iteration(Loop, Var, File) :-
    node(Loop, "LOOP"),
    edge(Loop, Var, "ITERATES_OVER"),
    attr_edge(Loop, Var, "ITERATES_OVER", "cardinality.scale", Scale),
    (Scale = "nodes" ; Scale = "unbounded"),
    attr(Loop, "file", File).
```

## Issues Encountered

None. Implementation was straightforward following the established patterns.

## Ready for Review

Implementation complete. All tests pass. Ready for Kevlin and Linus review.
