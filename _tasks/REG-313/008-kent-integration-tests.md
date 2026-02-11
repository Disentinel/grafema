# Kent Beck - Integration Tests for Nested attr() Paths

## Task

Add integration tests to verify the nested path feature works end-to-end through the Evaluator.

## Tests Added

Added 4 new integration tests to `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/datalog/tests.rs`:

### 1. `test_eval_attr_nested_path`
- Creates a node with nested JSON metadata: `{"config": {"host": "localhost", "port": 5432}}`
- Queries with `attr(200, "config.host", X)`
- Verifies `X` binds to `"localhost"`

### 2. `test_eval_attr_nested_number`
- Creates a node with nested number values: `{"connection": {"timeout": 3000, "retries": 5}}`
- Queries with `attr(300, "connection.timeout", X)`
- Verifies `X` binds to `"3000"` (number converted to string)

### 3. `test_eval_attr_literal_key_with_dots`
- Creates a node with BOTH a literal "app.name" key AND a nested "app.name" path
- Metadata: `{"app.name": "literal-value", "app": {"name": "nested-value"}}`
- Queries with `attr(400, "app.name", X)`
- Verifies `X` binds to `"literal-value"` (literal key takes precedence)
- **Critical for backward compatibility**

### 4. `test_eval_attr_nested_path_not_found`
- Creates a node with partial nested structure: `{"config": {"host": "localhost"}}`
- Queries with `attr(500, "config.port", X)` (port doesn't exist)
- Verifies empty results (no binding)

## Test Pattern

Followed existing `test_eval_attr_metadata` pattern:
1. Create tempdir
2. Create GraphEngine
3. Add node with nested metadata JSON
4. Create Evaluator
5. Query with `attr()` atom
6. Assert results

## Test Results

```
running 11 tests
test datalog::tests::eval_tests::test_eval_attr_file ... ok
test datalog::tests::eval_tests::test_eval_attr_constant_no_match ... ok
test datalog::tests::eval_tests::test_eval_attr_builtin ... ok
test datalog::tests::eval_tests::test_eval_attr_constant_match ... ok
test datalog::tests::eval_tests::test_eval_attr_metadata ... ok
test datalog::tests::eval_tests::test_eval_attr_nested_number ... ok
test datalog::tests::eval_tests::test_eval_attr_missing ... ok
test datalog::tests::eval_tests::test_eval_attr_literal_key_with_dots ... ok
test datalog::tests::eval_tests::test_eval_attr_type ... ok
test datalog::tests::eval_tests::test_eval_attr_nested_path ... ok
test datalog::tests::eval_tests::test_eval_attr_nested_path_not_found ... ok

test result: ok. 11 passed; 0 failed; 0 ignored
```

## Commit

```
c0553e7 test(datalog): Add integration tests for nested attr() paths
```

## Coverage

These integration tests complement the unit tests in `utils.rs`:
- **Unit tests** (utils.rs): Test `get_metadata_value()` function in isolation
- **Integration tests** (tests.rs): Test full evaluation pipeline through `Evaluator.eval_atom()`

The integration tests verify:
- JSON parsing from NodeRecord.metadata
- Value extraction via `get_metadata_value()`
- Binding creation in evaluation results
- Backward compatibility with literal keys
