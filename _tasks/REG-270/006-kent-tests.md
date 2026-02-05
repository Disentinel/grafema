# Kent Beck Test Report: REG-270 - Track Generator Function Yields

**Date:** 2026-02-05
**Task:** Create test suite for YIELDS and DELEGATES_TO edge creation
**Status:** TESTS WRITTEN (Ready for TDD cycle)

---

## Test File Location

**File:** `test/unit/YieldExpressionEdges.test.js`

I placed the test file at `test/unit/YieldExpressionEdges.test.js` rather than `test/unit/plugins/analysis/ast/` as suggested by Steve. Rationale:
- No existing tests exist in `test/unit/plugins/analysis/ast/` (directory is empty)
- The existing `ReturnStatementEdges.test.js` (our reference implementation) is at `test/unit/`
- Maintaining consistency with existing edge-testing patterns

---

## Test Coverage

### 17 Test Cases Covering:

| Category | Test Case | Description |
|----------|-----------|-------------|
| **Basic yield** | Numeric literal yield | `yield 42;` creates LITERAL --YIELDS--> FUNCTION |
| **Basic yield** | String literal yield | `yield 'hello';` creates LITERAL --YIELDS--> FUNCTION |
| **Variable yield** | Variable yield | `const result = 42; yield result;` creates VARIABLE --YIELDS--> FUNCTION |
| **Call yield** | Function call yield | `yield getValue();` creates CALL --YIELDS--> FUNCTION |
| **Call yield** | Method call yield | `yield obj.getValue();` creates CALL --YIELDS--> FUNCTION |
| **yield* delegation** | Delegation to function call | `yield* innerGen();` creates CALL --DELEGATES_TO--> FUNCTION |
| **yield* delegation** | Delegation to variable | `yield* gen;` creates VARIABLE --DELEGATES_TO--> FUNCTION |
| **yield* delegation** | Array literal delegation | `yield* [1,2,3];` creates DELEGATES_TO edge |
| **Multiple yields** | Multiple yields in generator | All yields create separate YIELDS edges |
| **Async generator** | Async generator yields | `async function* gen()` handles both async and generator |
| **Bare yield** | Bare yield (no value) | `yield;` creates NO edge |
| **Parameter yield** | Parameter yield | `yield x;` (param) creates PARAMETER --YIELDS--> FUNCTION |
| **Nested functions** | Nested generator separation | Inner yields don't affect outer function |
| **Edge direction** | Direction verification | src=value, dst=function |
| **Idempotency** | No duplicates on re-run | Running twice doesn't duplicate edges |
| **Expressions** | BinaryExpression yield | `yield a + b;` creates EXPRESSION + DERIVES_FROM edges |
| **Expressions** | MemberExpression yield | `yield obj.name;` creates EXPRESSION + DERIVES_FROM |
| **Expressions** | ConditionalExpression yield | `yield x ? y : z;` creates EXPRESSION + DERIVES_FROM |
| **Class methods** | Generator method | `*count(n) { yield i; }` in class |
| **Mixed** | Mixed yields and delegations | Same function with both yield and yield* |
| **Generator expression** | Function expression generator | `const gen = function* () { yield 42; }` |

---

## Adjustments from Joel's Spec

### 1. Added Additional Test Cases

Beyond Joel's 11 planned test cases, I added:
- **Edge direction verification** - explicit test that src=value, dst=function
- **No duplicates on re-run** - idempotency test (pattern from ReturnStatementEdges.test.js)
- **Generator function expression** - `const gen = function* () {}` pattern
- **Mixed yields and delegations** - generator using both yield and yield*
- **Generator class methods** - `*count(n)` in class
- **yield* with array literal** - `yield* [1, 2, 3]` delegation

### 2. Expression Yield Tests

Added tests for complex expression yields (mirrors REG-276 for return expressions):
- BinaryExpression: `yield a + b;`
- MemberExpression: `yield obj.name;`
- ConditionalExpression: `yield condition ? x : y;`

These verify EXPRESSION node creation and DERIVES_FROM edge connections.

### 3. Pattern Matching

Followed existing patterns from `ReturnStatementEdges.test.js`:
- Same setup/cleanup structure with `setupTest()` helper
- Same `createTestDatabase()` / `createTestOrchestrator()` usage
- Same assertion patterns for edge verification
- Same format for test descriptions and comments

---

## Test Structure

```
describe('YIELDS/DELEGATES_TO Edges (REG-270)')
  describe('Basic yield with literal')
    - numeric literal yield
    - string literal yield
  describe('Yield with variable')
    - variable yield
  describe('Yield with function call')
    - function call yield
  describe('yield* delegation')
    - delegation to function call
    - delegation to variable
  describe('Multiple yields')
    - multiple yields in generator
  describe('Async generators')
    - async generator yields
  describe('Bare yield')
    - no edge for bare yield
  describe('Yield parameter')
    - parameter yield
  describe('Nested functions')
    - nested generator separation
  describe('Yield with method call')
    - method call yield
  describe('Edge direction verification')
    - src=value, dst=function
  describe('No duplicates on re-run')
    - idempotency
  describe('Yield expressions')
    - BinaryExpression yield
    - MemberExpression yield
    - ConditionalExpression yield
  describe('Generator arrow functions')
    - generator function expression
  describe('Mixed yields and delegations')
    - both yield and yield* in same function
  describe('Yield in class methods')
    - generator method
  describe('yield* with iterable literals')
    - array literal delegation
```

---

## TDD Status

**Tests are expected to FAIL** until implementation is complete.

The tests cannot run in this worktree because the project is not built. Once Rob Pike implements:
1. Type definitions (YIELDS, DELEGATES_TO edge types)
2. YieldExpression visitor in JSASTAnalyzer
3. bufferYieldEdges() in GraphBuilder

The tests should be run with:
```bash
npm run build && node --test test/unit/YieldExpressionEdges.test.js
```

---

## Notes for Implementation

1. **Generator function detection**: Tests verify `func.generator === true` on FUNCTION nodes
2. **Async generator**: Tests verify both `func.async === true` and `func.generator === true`
3. **Edge direction**: All YIELDS/DELEGATES_TO edges point FROM the yielded value TO the generator function
4. **Nested function isolation**: Inner function yields must not create edges for outer function

---

*Kent Beck, Test Engineer*
*"Tests communicate intent. Write them first, make them pass later."*
