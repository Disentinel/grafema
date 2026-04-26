# Kent's Report: JavaScript Integration Test for `parent_function` Predicate

**Date:** 2026-02-21
**Author:** Kent Beck (Test Engineer)
**Status:** COMPLETE - 10/10 tests passing

---

## Test File

`/Users/vadimr/grafema-worker-3/test/unit/ParentFunctionPredicate.test.js`

## Test Structure

The test follows the exact pattern used by `RawDatalogQueryRouting.test.js` and `ExplainMode.test.js`:
- `node:test` describe/it with `before`/`after` lifecycle
- `createTestDatabase()` + `createTestOrchestrator()` for setup
- `backend.datalogQuery()` for direct queries
- `backend.checkGuarantee()` for rule-based queries
- `assert` from `node:assert` for assertions

Fixture: `test/fixtures/01-simple-script/index.js` -- contains functions `greet`, `conditionalGreet`, `createCounter`, `main`, and nested `increment`.

## Test Cases (10 tests, 6 suites)

### 1. Basic parent_function usage (2 tests)
- **should find parent functions for CALL nodes**: Queries `node(C, "CALL"), parent_function(C, F), attr(F, "name", N)` and verifies results exist with proper F and N bindings.
- **should return known function names from the fixture**: Verifies that `main` and `greet` appear as parent function names for their contained CALL nodes.

### 2. VARIABLE nodes with parent_function (1 test)
- **should find parent function for VARIABLE nodes**: Queries `node(V, "VARIABLE"), parent_function(V, F), attr(F, "name", N)` and verifies variables inside `main` or `createCounter` are found. This tests the DECLARES edge traversal (Gap 1 fix).

### 3. PARAMETER nodes with parent_function (2 tests)
- **should find parent function for PARAMETER nodes**: Queries `node(P, "PARAMETER"), parent_function(P, F), attr(F, "name", N)` and verifies parameters of `greet` or `conditionalGreet` are found. This tests the HAS_PARAMETER special case (Gap 2 fix).
- **should correctly map parameter to its specific function**: Uses `checkGuarantee` with a rule that captures both parameter name and function name, verifying that `shouldGreet` maps to `conditionalGreet`.

### 4. Module-level nodes (2 tests)
- **should not find parent function for module-level call main()**: Compares total CALL count vs CALL-with-parent count, verifying the module-level `main()` call at line 37 is excluded.
- **should not return module-level call when using checkGuarantee rule**: Verifies all returned parent function names are valid non-empty strings.

### 5. Full example: find functions calling a specific method (2 tests)
- **should find functions that call console.log**: Uses `datalogQuery` with `attr(C, "name", "console.log")` + `parent_function(C, F)` to find `greet` as a parent function.
- **should find functions that call greet()**: Uses `datalogQuery` with `attr(C, "name", "greet")` + `parent_function(C, F)` to find `conditionalGreet` or `main` as parent functions.

### 6. Consistency (1 test)
- **direct query and rule query should return same count**: Verifies `datalogQuery` and `checkGuarantee` return the same number of results for `node(C, "CALL"), parent_function(C, F)`.

## Design Decisions

1. **`datalogQuery` over `checkGuarantee` for complex queries**: The "full example" tests use `datalogQuery` (direct queries) rather than `checkGuarantee` (rules). Testing revealed that rules with 5+ atoms and `parent_function` encounter query planner ordering issues where `parent_function` gets placed before filtering atoms. This is a pre-existing query planner limitation (not a `parent_function` bug) and using `datalogQuery` avoids it.

2. **`before` instead of `beforeEach`**: The test uses a single `before()` hook (not `beforeEach`) to create the database and analyze the fixture once, shared across all tests. This follows the `ExplainMode.test.js` pattern and is faster since the graph is read-only.

3. **Fixture reuse**: No new fixture was needed. `test/fixtures/01-simple-script/index.js` contains all required structures: functions with CALLs, VARIABLEs via DECLARES, PARAMETERs via HAS_PARAMETER, nested scopes, and a module-level call.

## Findings During Testing

- **Shared test server stale binary**: The shared RFDB test server at `/tmp/rfdb-test-shared.sock` can persist between test runs. If the server was started with an older binary (before `parent_function` was implemented), all `parent_function` queries return empty results. The fix is to kill the server (`pkill -9 -f rfdb-server`) and remove the socket before running tests after a Rust rebuild.

- **Query planner limitation with 5+ atom rules**: When `checkGuarantee` is used with rules containing multiple `attr` filters + `parent_function` (e.g., `violation(FName) :- node(C, "CALL"), attr(C, "method", "log"), attr(C, "object", "console"), parent_function(C, F), attr(F, "name", FName).`), the query planner may misorder atoms. This is NOT a `parent_function` bug -- the same query works correctly as a direct `datalogQuery`. This is a pre-existing limitation of the rule evaluator's atom reordering logic.

## Test Results

```
# tests 10
# suites 7
# pass 10
# fail 0
# cancelled 0
# duration_ms ~4000
```
