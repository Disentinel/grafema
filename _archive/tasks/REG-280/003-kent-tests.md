# Kent Beck - Test Report for REG-280 (HAS_CONDITION Edge for LOOP)

## Task Summary

Added tests for HAS_CONDITION edge creation from LOOP nodes to their condition EXPRESSION nodes.

## Test Location

File: `/Users/vadimr/grafema-worker-1/test/unit/plugins/analysis/ast/loop-nodes.test.ts`

Added GROUP 10: "HAS_CONDITION edge for loop conditions (REG-280)" with 13 test cases.

## Test Cases

### Core Functionality Tests (Expected to FAIL until implementation)

1. **should create HAS_CONDITION edge from while LOOP to condition expression**
   - Tests: `while (queue.length > 0) { ... }`
   - Expects: HAS_CONDITION edge from LOOP node to condition expression

2. **should create HAS_CONDITION edge from do-while LOOP to condition expression**
   - Tests: `do { ... } while (i < 10);`
   - Expects: HAS_CONDITION edge from LOOP node to condition expression

3. **should create HAS_CONDITION edge from for LOOP to test expression**
   - Tests: `for (let i = 0; i < 10; i++) { ... }`
   - Expects: HAS_CONDITION edge from LOOP node to test expression

### Negative Tests (Expected to PASS - no condition edge needed)

4. **should NOT create HAS_CONDITION edge for infinite for loop (;;)**
   - Tests: `for (;;) { ... }`
   - Expects: No HAS_CONDITION edge (no test expression)
   - Status: PASS

5. **should NOT create HAS_CONDITION edge for for-of loop**
   - Tests: `for (const item of items) { ... }`
   - Expects: No HAS_CONDITION edge (uses ITERATES_OVER instead)
   - Status: PASS

6. **should NOT create HAS_CONDITION edge for for-in loop**
   - Tests: `for (const key in obj) { ... }`
   - Expects: No HAS_CONDITION edge (uses ITERATES_OVER instead)
   - Status: PASS

### Expression Type Coverage Tests (Expected to FAIL)

7. **should handle simple Identifier as condition (while variable)**
   - Tests: `while (condition) { ... }`

8. **should handle CallExpression as condition (while fn())**
   - Tests: `while (hasNext(iterator)) { ... }`

9. **should handle MemberExpression as condition (while obj.prop)**
   - Tests: `while (state.isActive) { ... }`

10. **should handle UnaryExpression (negation) as condition (while !done)**
    - Tests: `while (!done) { ... }`

11. **should handle LogicalExpression as condition (while a && b)**
    - Tests: `while (queue.length > 0 && limit > 0) { ... }`

### Edge Cases (Expected to FAIL)

12. **should create separate HAS_CONDITION edges for nested loops**
    - Tests nested while loops each have their own HAS_CONDITION edge
    - Verifies distinct destination nodes (different condition expressions)

13. **should have valid HAS_CONDITION edge connectivity**
    - Verifies both src and dst nodes exist
    - Confirms src is LOOP type

## Test Results

```
Tests:       10 failed, 3 passed (13 total)
Suites:      1 failed (HAS_CONDITION edge for loop conditions)
```

### Detailed Results

| Test | Status | Notes |
|------|--------|-------|
| while LOOP HAS_CONDITION | FAIL | Feature not implemented |
| do-while LOOP HAS_CONDITION | FAIL | Feature not implemented |
| for LOOP HAS_CONDITION | FAIL | Feature not implemented |
| infinite for (;;) no edge | PASS | Correctly no edge |
| for-of no edge | PASS | Uses ITERATES_OVER |
| for-in no edge | PASS | Uses ITERATES_OVER |
| Identifier condition | FAIL | Feature not implemented |
| CallExpression condition | FAIL | Feature not implemented |
| MemberExpression condition | FAIL | Feature not implemented |
| UnaryExpression condition | FAIL | Feature not implemented |
| LogicalExpression condition | FAIL | Feature not implemented |
| Nested loops separate edges | FAIL | Feature not implemented |
| Edge connectivity valid | FAIL | Feature not implemented |

## Test Pattern

Tests follow existing patterns from:
- `loop-nodes.test.ts` (GROUP 1-9 tests for LOOP, HAS_BODY, ITERATES_OVER)
- `if-statement-nodes.test.ts` (HAS_CONDITION tests for BRANCH nodes)

## Implementation Requirements

Based on these tests, Rob Pike should:

1. **Detect loop condition expressions:**
   - WhileStatement: `node.test`
   - DoWhileStatement: `node.test`
   - ForStatement: `node.test` (may be null for `for(;;)`)

2. **Create EXPRESSION node** for the condition (if not already exists)

3. **Create HAS_CONDITION edge** from LOOP node to EXPRESSION node

4. **Skip for for-in/for-of loops** - they don't have a test expression

5. **Handle all expression types:**
   - Identifier
   - BinaryExpression
   - CallExpression
   - MemberExpression
   - UnaryExpression
   - LogicalExpression

## Notes

- Existing LOOP node implementation is in place (REG-267 Phase 2)
- HAS_CONDITION edge type already exists in `@grafema/types`
- Pattern matches if-statement HAS_CONDITION implementation for BRANCH nodes
- Tests are TDD-compliant: they fail first, implementation comes next
