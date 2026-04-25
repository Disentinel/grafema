# REG-556: Kent Beck Test Report -- PASSES_ARGUMENT Edges

## Test File

`/Users/vadimr/grafema-worker-1/test/unit/CallNodePassesArgument.test.js`

## Test Results

**6/6 PASS** -- all tests green, total duration ~980ms.

```
# tests 6
# suites 7
# pass 6
# fail 0
```

## Tests Written

| # | Test | What it verifies | Status |
|---|------|------------------|--------|
| 1 | Core acceptance: `foo(a, b.c, new X())` | Mixed argument types produce exactly 3 PASSES_ARGUMENT edges from the CALL node | PASS |
| 2 | Function-body direct call (Gap #1) | `inner(val)` inside `outer()` creates 1 PASSES_ARGUMENT edge pointing to VARIABLE `val` | PASS |
| 3 | Module-level constructor call (Gap #2) | `new Logger(opts)` at module level creates 1 PASSES_ARGUMENT edge from CONSTRUCTOR_CALL to VARIABLE `opts` | PASS |
| 4 | Function-body constructor call (Gap #3) | `new Plugin(config)` inside `setup()` creates 1 PASSES_ARGUMENT edge from CONSTRUCTOR_CALL to VARIABLE `config` | PASS |
| 5 | Logical expression argument (regression) | `process(x || y)` creates 1 PASSES_ARGUMENT edge pointing to EXPRESSION node | PASS |
| 6 | No arguments (regression) | `noop()` creates 0 PASSES_ARGUMENT edges | PASS |

## Test Pattern

Each test follows the inline `setupTest()` pattern (matching `ConstructorCallTracking.test.js`):
1. Write source to temp dir with `package.json`
2. Run full analysis pipeline via `createTestOrchestrator(backend)`
3. Query `getAllNodes()` / `getAllEdges()` to find CALL/CONSTRUCTOR_CALL nodes
4. Assert correct number and targets of PASSES_ARGUMENT edges

## Coverage of REG-556 Gaps

- **Gap #1** (function-body direct calls): Test 2 directly verifies this
- **Gap #2** (module-level `new Foo(arg)`): Test 3 directly verifies this
- **Gap #3** (function-body `new Foo(arg)`): Test 4 directly verifies this
- **Regression guards**: Tests 5 and 6 ensure existing behavior is not broken
- **Acceptance criteria**: Test 1 verifies the complete scenario from the task description
