# REG-107: ArgumentExpression Tests - Kent Beck Report

**Date:** 2025-01-22
**Author:** Kent Beck (Test Engineer)
**Task:** Write tests for ArgumentExpressionNode factory migration

---

## Executive Summary

Tests written following TDD discipline. Two test files created:

1. **ArgumentExpression.test.js** - Unit tests for ArgumentExpressionNode functionality
2. **NoLegacyExpressionIds.test.js** - Enforcement tests to prevent regression

**Status:** Tests will FAIL initially (by design). Implementation comes next.

**Test Philosophy:** Tests define the contract. They communicate intent clearly. No mocks in production paths.

---

## Test Files Created

### 1. ArgumentExpression.test.js

**Location:** `/Users/vadimr/grafema/test/unit/ArgumentExpression.test.js`

**Coverage:**

#### ArgumentExpressionNode.create() Tests
- ✓ Creates node with required fields (parentCallId, argIndex)
- ✓ Generates colon-based ID format (not hash)
- ✓ Supports counter suffix for disambiguation
- ✓ Validates required field presence
- ✓ Accepts argIndex: 0 as valid (edge case)
- ✓ Inherits base ExpressionNode validation
- ✓ Supports all ExpressionNode optional fields

#### ArgumentExpressionNode.validate() Tests
- ✓ Validates required fields (parentCallId, argIndex)
- ✓ Passes with all required fields present
- ✓ Inherits base ExpressionNode validation errors

#### NodeFactory.createArgumentExpression() Tests
- ✓ Creates ArgumentExpression via factory
- ✓ Generates colon-based IDs
- ✓ Delegates to ArgumentExpressionNode.create()

#### ID Format Validation Tests
- ✓ Uses colon separator (not hash)
- ✓ Places EXPRESSION as type marker in ID
- ✓ Preserves line and column in ID

#### Field Constants Tests
- ✓ REQUIRED array extends base with parentCallId, argIndex
- ✓ OPTIONAL array includes counter field

**Total Test Cases:** 20

**Pattern Matched:** ClassNodeSemanticId.test.js structure
- Clear describe blocks
- One assertion per test
- Tests communicate intent
- No mocks

---

### 2. NoLegacyExpressionIds.test.js

**Location:** `/Users/vadimr/grafema/test/unit/NoLegacyExpressionIds.test.js`

**Coverage:**

#### Legacy Format Detection
- ✓ No EXPRESSION# in production TypeScript/JavaScript
- ✓ No EXPRESSION# template literals
- ✓ No inline EXPRESSION object literals in visitors

#### Factory Usage Verification
- ✓ VariableVisitor uses NodeFactory.createExpression()
- ✓ CallExpressionVisitor uses NodeFactory.createArgumentExpression()
- ✓ Key files import NodeFactory

#### GraphBuilder Validation
- ✓ Validates colon-based EXPRESSION IDs
- ✓ Does not create legacy format IDs

#### ArgumentExpressionNode Existence
- ✓ ArgumentExpressionNode.ts file exists
- ✓ Exported from nodes/index.ts
- ✓ NodeFactory has createArgumentExpression method
- ✓ NodeFactory imports ArgumentExpressionNode

#### ID Format Structure
- ✓ Production code uses colon format
- ✓ No hash-based ID patterns

#### Type Exports
- ✓ ArgumentExpressionNodeRecord exported
- ✓ ArgumentExpressionNodeOptions exported

**Total Test Cases:** 18

**Pattern Matched:** NoLegacyClassIds.test.js structure
- Uses grep via execSync
- Filters out comments/documentation
- Validates file existence
- Checks imports and exports

---

## Test Philosophy Applied

### TDD Discipline

**Red-Green-Refactor:**
1. **Red:** Tests written first - they WILL fail
2. **Green:** Rob implements to make tests pass
3. **Refactor:** Kevlin reviews for quality

These tests define the contract BEFORE implementation.

### Tests Communicate Intent

**Example: Required Fields**
```javascript
it('should throw error if parentCallId is missing', () => {
  assert.throws(() => {
    ArgumentExpressionNode.create(/* ... */, { argIndex: 0 });
  }, /parentCallId is required/);
});
```

**Intent:** parentCallId is NOT optional. Missing it is an error, not a warning.

**Example: ID Format**
```javascript
it('should generate ID in colon format', () => {
  const node = ArgumentExpressionNode.create(/* ... */);

  assert.strictEqual(node.id, '/src/app.js:EXPRESSION:BinaryExpression:25:10');
  assert.ok(node.id.includes(':EXPRESSION:'));
  assert.ok(!node.id.includes('EXPRESSION#'));
});
```

**Intent:** New format is colon-based. Hash format is explicitly forbidden.

### No Mocks in Production Paths

All tests either:
- Test factory functions directly (unit tests)
- Use grep to verify code structure (enforcement tests)
- No mocking of ArgumentExpressionNode or NodeFactory

### Edge Cases Covered

**Edge Case 1: argIndex: 0**
```javascript
it('should accept argIndex: 0 as valid', () => {
  const node = ArgumentExpressionNode.create(/* ..., argIndex: 0 */);
  assert.strictEqual(node.argIndex, 0);
});
```

**Why:** `if (options.argIndex)` would be a bug. Zero is a valid argument index.

**Edge Case 2: Counter Suffix**
```javascript
it('should generate ID with counter suffix when provided', () => {
  const node = ArgumentExpressionNode.create(/* ..., counter: 3 */);
  assert.strictEqual(node.id, '/src/app.js:EXPRESSION:BinaryExpression:25:10:3');
});
```

**Why:** Multiple expressions at same location need disambiguation.

---

## Test Naming Convention

**Pattern:** `should [expected behavior]`

**Good:**
- `should create ArgumentExpression with required fields`
- `should throw error if parentCallId is missing`
- `should generate ID in colon format`

**Avoid:**
- `test ArgumentExpression creation` (vague)
- `it works` (meaningless)
- `creates node` (no assertion context)

---

## Assertion Strategy

### One Assertion Per Test

**Example:**
```javascript
// GOOD: One concept per test
it('should throw error if parentCallId is missing', () => {
  assert.throws(() => { /* ... */ }, /parentCallId is required/);
});

it('should throw error if argIndex is missing', () => {
  assert.throws(() => { /* ... */ }, /argIndex is required/);
});
```

**NOT:**
```javascript
// BAD: Multiple concepts in one test
it('should validate required fields', () => {
  assert.throws(() => { /* missing parentCallId */ }, /parentCallId/);
  assert.throws(() => { /* missing argIndex */ }, /argIndex/);
  assert.throws(() => { /* missing expressionType */ }, /expressionType/);
});
```

**Why:** When test fails, you know EXACTLY which assertion broke.

### Strict Equality Where Possible

**Prefer:**
- `assert.strictEqual(node.type, 'EXPRESSION')` over `assert.ok(node.type === 'EXPRESSION')`
- `assert.strictEqual(errors.length, 0)` over `assert.ok(!errors.length)`

**Why:** Better error messages when test fails.

---

## Enforcement Tests Design

### Pattern: Grep + Filter + Assert

**Structure:**
1. Run grep command
2. Filter out comments/documentation
3. Assert zero matches

**Example:**
```javascript
const result = execSync(`grep -r "EXPRESSION#" packages/core/src ...`);
const matches = result
  .split('\n')
  .filter(line => line.trim())
  .filter(line => !line.includes('//'))
  .filter(line => !line.includes('/*'));

assert.strictEqual(matches.length, 0, 'Found EXPRESSION# in code');
```

**Why This Works:**
- Catches manual ID construction
- Survives refactoring
- Fails fast if someone bypasses factory
- Zero maintenance (no mocking)

### Multiple Pattern Coverage

**Patterns Checked:**
- `EXPRESSION#` (literal string)
- `EXPRESSION#\${` (template literal)
- `"EXPRESSION#"` (string concatenation)
- `'EXPRESSION#'` (single quotes)
- `type: 'EXPRESSION'` (inline object literal)

**Why:** Developers find creative ways to bypass patterns. Cover all variations.

---

## Test Failure Expectations

### ArgumentExpression.test.js

**Expected Failures:**

1. **Module Not Found**
   ```
   Error: Cannot find module '@grafema/core'
   Cannot find ArgumentExpressionNode
   ```
   **Reason:** ArgumentExpressionNode.ts doesn't exist yet

2. **Method Not Found**
   ```
   TypeError: ArgumentExpressionNode.create is not a function
   ```
   **Reason:** Class not implemented

3. **Factory Method Missing**
   ```
   TypeError: NodeFactory.createArgumentExpression is not a function
   ```
   **Reason:** Method not added to NodeFactory

**After Part 1 Implementation:** All tests should pass.

### NoLegacyExpressionIds.test.js

**Expected Failures:**

1. **Phase 1 (Infrastructure Only):**
   ```
   - VariableVisitor should use NodeFactory.createExpression() ✗
   - CallExpressionVisitor should use NodeFactory.createArgumentExpression() ✗
   - No EXPRESSION# in production code ✗ (existing code still has it)
   ```

2. **Phase 2 (After VariableVisitor Migration):**
   ```
   - VariableVisitor should use NodeFactory.createExpression() ✓
   - CallExpressionVisitor should use NodeFactory.createArgumentExpression() ✗
   - Some EXPRESSION# patterns eliminated ✓
   ```

3. **Phase 3 (After CallExpressionVisitor Migration):**
   ```
   - All visitor tests pass ✓
   - No EXPRESSION# in production code ✓
   ```

**Final State:** All enforcement tests pass.

---

## Integration with Existing Tests

### Expression.test.js

**Recommendation:** Add ID format test to existing Expression.test.js

**New Test Case:**
```javascript
describe('EXPRESSION node ID format', () => {
  it('should use colon-based ID format (not hash-based)', async () => {
    const { backend, testDir } = await setupTest({
      'index.js': `
        const obj = { method: () => {} };
        const m = obj.method;
      `
    });

    try {
      let expressionNode = null;
      for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
        expressionNode = node;
        break;
      }

      assert.ok(expressionNode, 'Should find EXPRESSION node');
      assert.ok(
        expressionNode.id.includes(':EXPRESSION:'),
        `EXPRESSION ID should use colon format, got: ${expressionNode.id}`
      );
      assert.ok(
        !expressionNode.id.includes('EXPRESSION#'),
        `EXPRESSION ID should NOT use hash format, got: ${expressionNode.id}`
      );
    } finally {
      await cleanup(backend, testDir);
    }
  });
});
```

**Why:** Validates end-to-end ID format in real analysis.

**Location:** Add to `/Users/vadimr/grafema/test/unit/Expression.test.js`

**When:** After Part 2 migration (VariableVisitor or CallExpressionVisitor)

---

## Test Coverage Analysis

### What's Tested

**Factory API:**
- ✓ ArgumentExpressionNode.create()
- ✓ NodeFactory.createArgumentExpression()
- ✓ Field validation
- ✓ ID generation
- ✓ Counter suffix logic

**Enforcement:**
- ✓ No legacy EXPRESSION# format
- ✓ Factory usage in key files
- ✓ Module exports
- ✓ GraphBuilder validation

**Edge Cases:**
- ✓ argIndex: 0 handling
- ✓ Counter suffix
- ✓ Empty/missing required fields
- ✓ Inheritance from ExpressionNode

### What's NOT Tested (Intentional)

**Integration Behavior:**
- How VariableVisitor uses the factory (tested in Expression.test.js)
- How CallExpressionVisitor creates edges (tested in existing tests)
- GraphBuilder node reconstruction (covered by integration tests)

**Why:** Unit tests focus on factory contract. Integration tests cover visitor behavior.

**Implementation Details:**
- Internal _computeName() logic (tested via public API)
- ID parsing (not part of contract)

**Why:** Tests should test behavior, not implementation.

---

## Test Maintenance Strategy

### When to Update Tests

**DO update tests if:**
- Factory API changes (e.g., new required field)
- ID format changes (breaking change)
- Validation rules change

**DON'T update tests if:**
- Internal implementation refactored
- Performance optimization
- Code comments changed

### Enforcement Test Maintenance

**Grep patterns may need updating if:**
- File structure changes (e.g., visitors moved to different directory)
- New files added that create EXPRESSION nodes

**Pattern:**
```javascript
// If files move, update path:
const file = 'packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts';
// becomes
const file = 'packages/core/src/visitors/VariableVisitor.ts';
```

**Benefit of grep tests:** Minimal maintenance. No mocks to update.

---

## Running the Tests

### Run ArgumentExpression Tests Only

```bash
node --test test/unit/ArgumentExpression.test.js
```

**Expected:** 20 tests, all FAIL initially

### Run Enforcement Tests Only

```bash
node --test test/unit/NoLegacyExpressionIds.test.js
```

**Expected:** 18 tests, most FAIL initially

### Run All Unit Tests

```bash
npm test
```

**Expected:** New tests FAIL, existing tests PASS (if they passed before)

### Run After Phase 1 Implementation

```bash
node --test test/unit/ArgumentExpression.test.js
```

**Expected:** All 20 tests PASS

```bash
node --test test/unit/NoLegacyExpressionIds.test.js
```

**Expected:** Some tests PASS (ArgumentExpressionNode exists), most FAIL (visitors not migrated)

---

## Test Quality Checklist

- [x] Tests written before implementation (TDD)
- [x] Each test has clear name communicating intent
- [x] One assertion per test (or related assertions)
- [x] No mocks in production paths
- [x] Edge cases covered (argIndex: 0, counter suffix)
- [x] Error cases tested (missing required fields)
- [x] Enforcement tests prevent regression
- [x] Tests match existing patterns (ClassNode, NoLegacyClassIds)
- [x] Documentation explains what's tested and why

---

## Next Steps

**For Rob Pike (Implementation):**

1. Read these tests to understand the contract
2. Implement ArgumentExpressionNode to make unit tests pass
3. Migrate visitors to make enforcement tests pass
4. Run tests after each change

**For Kevlin Henney (Review):**

1. Review test quality and clarity
2. Check if tests communicate intent
3. Verify edge cases are covered
4. Suggest improvements to test naming/structure

**For Linus Torvalds (High-Level Review):**

1. Verify tests align with project vision
2. Check that enforcement tests prevent hacks
3. Confirm no over-testing (testing implementation details)

---

## Observations & Recommendations

### Observation 1: Counter Suffix Logic

**Test written:**
```javascript
it('should generate ID with counter suffix when provided', () => {
  const node = ArgumentExpressionNode.create(/* ..., counter: 3 */);
  assert.strictEqual(node.id, '/src/app.js:EXPRESSION:BinaryExpression:25:10:3');
});
```

**Question from Linus:** Is counter actually needed?

**Test Stance:** Test defines the contract. If counter is needed (per Joel's spec), test validates it works. If it's NOT needed, remove the test when removing the feature.

**Recommendation:** Keep test. If counter is removed during implementation, delete this test.

### Observation 2: No Integration Tests for GraphBuilder

**Why:** Linus flagged GraphBuilder as needing investigation. Writing integration tests now would be premature.

**Recommendation:** Wait for Don's GraphBuilder investigation. Then add integration tests if needed.

### Observation 3: Enforcement Tests Depend on File Structure

**Risk:** If files move, grep paths break.

**Mitigation:** Use wildcards where possible:
```javascript
const visitorFiles = 'packages/core/src/plugins/analysis/ast/visitors/*.ts';
```

**Benefit:** Survives minor refactoring.

### Observation 4: argIndex: 0 Edge Case

**Critical:** This test catches a common bug:
```javascript
if (options.argIndex) { /* BUG: 0 is falsy */ }
```

**Correct:**
```javascript
if (options.argIndex !== undefined) { /* Correct */ }
```

**Test ensures:** Rob implements this correctly.

---

## Alignment with Project Vision

### TDD Discipline

**Project Rule:** "New features/bugfixes: write tests first"

**Compliance:** ✓ Tests written before implementation

### Tests Communicate Intent

**Project Rule:** "Tests must communicate intent clearly"

**Compliance:** ✓ Clear test names, one concept per test

### No Mocks in Production Paths

**Project Rule:** "No mocks in production code paths"

**Compliance:** ✓ Direct API testing, grep for enforcement

### Match Existing Patterns

**Project Rule:** "Match existing patterns in the codebase"

**Compliance:** ✓ Followed ClassNodeSemanticId.test.js and NoLegacyClassIds.test.js patterns

---

## Summary

**Tests Created:** 2 files, 38 test cases
**Pattern:** TDD discipline, clear intent, no mocks
**Status:** Ready for implementation
**Expected Outcome:** Tests FAIL now, PASS after Rob's implementation

**Key Tests:**
1. ArgumentExpressionNode.create() validates required fields
2. ID format is colon-based (not hash)
3. NodeFactory delegates to ArgumentExpressionNode
4. No legacy EXPRESSION# in production code
5. Visitors use factory methods

**Philosophy:** Tests define the contract. They communicate what the code SHOULD do, not what it currently does.

**Next:** Rob implements to make tests pass.

---

**Kent Beck**
*Test Engineer*
*"Tests are documentation that validates itself"*
