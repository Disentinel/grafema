# Kent Beck's Test Report: REG-312 Member Expression Updates

**Test File:** `/Users/vadimr/grafema-worker-4/test/unit/UpdateExpressionMember.test.js`

**Status:** Tests written (RED phase - TDD)

## Test Structure

Following the exact pattern from `VariableReassignment.test.js`:
- Setup helper for creating test projects
- Organized test suites by feature category
- Clear assertions with helpful error messages
- Real-world integration scenarios
- Edge direction verification

## Test Coverage

### 1. Basic Member Expression Updates (6 tests)
**Tests:**
- `obj.count++` postfix increment
- `++obj.count` prefix increment
- `obj.count--` postfix decrement
- `--obj.count` prefix decrement
- MODIFIES edge verification (UPDATE_EXPRESSION -> VARIABLE(obj))
- READS_FROM self-loop verification (obj -> obj)

**Intent:** Verify basic member expression tracking with all node attributes and edges. Tests cover both operators (++ and --) and both positions (prefix and postfix).

**Key assertions:**
- Node created with targetType='MEMBER_EXPRESSION'
- objectName='obj', propertyName='count'
- mutationType='property'
- operator and prefix fields correct
- MODIFIES edge: src=UPDATE_EXPRESSION, dst=VARIABLE(obj)
- READS_FROM self-loop on object variable

---

### 2. Computed Property Updates (4 tests)
**Tests:**
- `arr[0]++` with numeric literal
- `arr[i]++` with variable index
- `obj["key"]++` with string literal
- `obj[key]++` with variable key

**Intent:** Verify computed property tracking with proper mutationType and computedPropertyVar fields.

**Key verification:**
- Static string literal (`obj["key"]++`) -> mutationType='property', propertyName='key'
- Variable index (`arr[i]++`) -> mutationType='computed', computedPropertyVar='i'
- Numeric literal (`arr[0]++`) -> mutationType='computed'

---

### 3. This Reference Updates (3 tests)
**Tests:**
- `this.value++` in class method
- MODIFIES edge pointing to CLASS node (not variable)
- enclosingClassName captured

**Intent:** Verify this.prop++ tracking follows REG-152 pattern (resolves to CLASS node).

**Key verification:**
- objectName='this'
- MODIFIES edge: UPDATE_EXPRESSION -> CLASS (not VARIABLE)
- enclosingClassName field populated with class name

---

### 4. Scope Integration (3 tests)
**Tests:**
- Module-level update (no CONTAINS edge)
- Function-level update (CONTAINS edge from function scope)
- Nested scope update (CONTAINS edge from if-block scope)

**Intent:** Verify CONTAINS edges work correctly at all scope levels.

**Key verification:**
- Module-level: NO CONTAINS edge (parentScopeId undefined)
- Function-level: CONTAINS edge from function SCOPE
- Nested: CONTAINS edge from innermost scope (if/while/etc)

---

### 5. Edge Cases and Limitations (3 tests)
**Tests:**
- Chained access skipped: `obj.nested.prop++` (documented limitation)
- Complex expressions skipped: `(obj || fallback).count++` (documented limitation)
- Mixed updates: both `i++` (IDENTIFIER) and `obj.i++` (MEMBER_EXPRESSION) in same file

**Intent:** Document what IS and ISN'T tracked. Verify behavior at boundaries.

**Key verification:**
- Chained access -> NO node created (matches detectObjectPropertyAssignment pattern)
- Complex expressions -> NO node created (matches existing limitations)
- Mixed updates -> both IDENTIFIER and MEMBER_EXPRESSION nodes created

---

### 6. Real-World Patterns (3 tests)
**Tests:**
- For-loop with array element: `for (let i = 0; i < 10; i++) arr[i]++`
- Counter in object literal: `stats.hits++`, `stats.misses++`
- Multiple properties on same object: `coords.x++; coords.y++; coords.z++`

**Intent:** Verify tracking works in common real-world patterns.

**Key verification:**
- For-loop: both `i++` (IDENTIFIER) and `arr[i]++` (MEMBER_EXPRESSION) tracked
- Object literal counters: multiple UPDATE_EXPRESSION nodes, all modify same object
- Multiple properties: verify all MODIFIES edges point to same object variable

---

### 7. Edge Direction Verification (2 tests)
**Tests:**
- MODIFIES direction: src=UPDATE_EXPRESSION, dst=VARIABLE
- READS_FROM direction: src=VARIABLE, dst=VARIABLE (self-loop)

**Intent:** Explicitly verify edge directions match spec (critical for graph queries).

---

## Test Assertions

All tests use clear, specific assertions with helpful error messages:
```javascript
assert.ok(updateNode, 'UPDATE_EXPRESSION node not created for obj.count++');
assert.strictEqual(updateNode.targetType, 'MEMBER_EXPRESSION', 'targetType should be MEMBER_EXPRESSION');
assert.strictEqual(updateNode.objectName, 'obj', 'objectName should be "obj"');
assert.strictEqual(updateNode.propertyName, 'count', 'propertyName should be "count"');
```

**Why:** If test fails, error message clearly indicates WHAT failed and WHERE.

---

## TDD Discipline

**IMPORTANT:** These tests WILL FAIL until implementation is complete.

**Expected failures:**
1. No UPDATE_EXPRESSION nodes found with targetType='MEMBER_EXPRESSION' (not created yet)
2. No MODIFIES edges from UPDATE_EXPRESSION to object variables (implementation not done)
3. No READS_FROM self-loops on objects (not created yet)
4. No fields: objectName, propertyName, mutationType, computedPropertyVar (types not updated)

**Success criteria:**
- All tests pass after implementation
- No tests skipped or disabled
- No "test to be written" comments
- Both IDENTIFIER (REG-288) and MEMBER_EXPRESSION (REG-312) updates work

---

## Pattern Consistency

Followed VariableReassignment.test.js patterns:
1. Same test helper structure (`setupTest`)
2. Same describe/it organization
3. Same assertion style
4. Same edge direction verification approach
5. Same real-world integration tests

**Additional patterns from REG-288:**
- Mixed IDENTIFIER and MEMBER_EXPRESSION updates in same test
- Scope-level verification (module vs function vs nested)
- Operator and prefix field verification

**Why:** Consistency makes tests easier to maintain and understand.

---

## Test Count Summary

**Total tests written:** 24

**Breakdown:**
- Basic functionality: 6 tests
- Computed properties: 4 tests
- This references: 3 tests
- Scope integration: 3 tests
- Edge cases: 3 tests
- Real-world patterns: 3 tests
- Edge direction: 2 tests

**Coverage level:** Comprehensive

- All operators covered (++, --)
- All positions covered (prefix, postfix)
- All property types covered (property, computed, static string)
- All scopes covered (module, function, nested)
- All edge types covered (MODIFIES, READS_FROM, CONTAINS)
- Both object types covered (regular objects, this references)
- All limitations documented (chained access, complex expressions)

---

## Test Communication

Each test name clearly states WHAT it verifies:
- "should create UPDATE_EXPRESSION node for obj.count++"
- "should create MODIFIES edge from UPDATE_EXPRESSION to object VARIABLE"
- "should verify READS_FROM edge direction (src=VARIABLE, dst=VARIABLE)"

**Why:** Test names are documentation. Anyone can understand what the feature does by reading test names.

---

## Verification Run

```bash
node --test test/unit/UpdateExpressionMember.test.js
```

**Result:** All tests RED (failing) as expected.

**First failure:**
```
not ok 1 - should create UPDATE_EXPRESSION node for obj.count++
  error: 'UPDATE_EXPRESSION node not created for obj.count++'
```

**This is correct!** Tests should fail until Rob implements the feature.

---

## Next Steps

1. **Rob Pike:** Implement feature (Joel's 3-file plan: types.ts, JSASTAnalyzer.ts, GraphBuilder.ts)
2. **Run tests:** `node --test test/unit/UpdateExpressionMember.test.js`
3. **Expected:** All tests RED (failures) initially
4. **After implementation:** All tests GREEN (passing)
5. **If stuck:** Tests communicate intent - read test names and assertions

---

## Integration with REG-288

These tests complement REG-288 (identifier updates):
- REG-288: `i++`, `--count` (targetType='IDENTIFIER')
- REG-312: `obj.prop++`, `arr[i]++` (targetType='MEMBER_EXPRESSION')

**Discriminated union pattern:** Both use same UPDATE_EXPRESSION node type, differentiated by targetType field.

**Test verification:** Mixed update test ensures both types coexist correctly.

---

**Kent Beck's Sign-off:**

Tests written following TDD discipline. Tests communicate intent clearly. Pattern matches existing VariableReassignment and expected REG-288 tests. Ready for implementation phase.

All tests will be RED until Rob completes implementation. That's exactly how TDD should work.

The tests cover all scenarios from Joel's tech plan:
- Basic member expressions (4.1)
- Computed properties (4.2)
- This references (4.3)
- Scope integration (4.4)
- Edge cases (4.5)
- Real-world patterns (4.6)

Plus edge direction verification and integration with REG-288.

---

**File:** `/Users/vadimr/grafema-worker-4/test/unit/UpdateExpressionMember.test.js`
**Lines:** 797
**Test count:** 24
**Status:** RED (expected)
