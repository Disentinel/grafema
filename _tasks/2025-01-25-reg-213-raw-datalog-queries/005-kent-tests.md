# Kent Beck - Test Report: `type()` Predicate Alias

## Summary

Added comprehensive tests for the `type(Id, Type)` predicate alias in the Datalog evaluator. These tests verify that `type()` behaves identically to `node()` across all argument patterns.

## Tests Added

File: `/Users/vadimr/grafema-worker-6/rust-engine/src/datalog/tests.rs`

### Test Cases

1. **`test_eval_type_find_by_type`**
   - Pattern: `type(X, "queue:publish")` (X is variable, Type is constant)
   - Verifies: Finding all nodes of a specific type
   - Expected: 2 results (nodes 1 and 3)

2. **`test_eval_type_find_type_of_node`**
   - Pattern: `type("1", Type)` (Id is constant, Type is variable)
   - Verifies: Finding the type of a specific node
   - Expected: 1 result with Type = "queue:publish"

3. **`test_eval_type_check_specific`**
   - Pattern: `type("1", "queue:publish")` (both constants)
   - Verifies: Checking if a node has a specific type
   - Expected: 1 result if match, 0 if no match
   - Includes both positive and negative cases

4. **`test_eval_type_enumerate_all`**
   - Pattern: `type(X, Y)` (both variables)
   - Verifies: Enumerating all nodes with their types
   - Expected: 4 results (all nodes in test graph)

5. **`test_eval_type_in_rule`**
   - Tests `type()` used within a Datalog rule
   - Rule: `publisher(X) :- type(X, "queue:publish").`
   - Expected: 2 results (same as equivalent `node()` test)

6. **`test_eval_type_equivalence_to_node`**
   - Directly compares `type()` and `node()` results
   - Verifies exact behavioral equivalence
   - Both queries for FUNCTION type should return node 4

## Test Status

Tests are written and will **FAIL** until implementation is complete. This is intentional TDD - tests define the expected behavior before implementation.

### Build Issue Note

During test execution, encountered an environmental linker issue (clang segfault on tokio-macros). This is unrelated to the tests themselves - it's a system-level issue with the Rust toolchain/Xcode on this machine.

## Implementation Guidance

To pass these tests, the evaluator needs to:

1. Recognize `"type"` as a predicate name
2. Route `type(Id, Type)` queries to the same handler as `node(Id, Type)`
3. Ensure all argument patterns (var/const combinations) work identically

Simplest implementation approach:
```rust
// In eval_builtin_atom or similar
match atom.predicate() {
    "node" | "type" => self.eval_node(atom, bindings),
    // ... other predicates
}
```

## Files Modified

- `/Users/vadimr/grafema-worker-6/rust-engine/src/datalog/tests.rs` - Added 6 new test functions
