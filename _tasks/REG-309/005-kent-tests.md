# Kent Beck - Test Report for REG-309

**Task**: Scope-aware variable lookup for mutations
**Date**: 2026-02-01
**Author**: Kent Beck (Test Engineer)

---

## Summary

Created comprehensive test suite for scope-aware variable lookup in mutations. Test file: `test/unit/ScopeAwareVariableLookup.test.js`

**Total test scenarios**: 26 tests across 9 describe blocks

**Coverage areas**:
- Variable reassignments with shadowing
- Array mutations with scope awareness
- Object mutations with scope awareness
- Parameter mutations in nested scopes
- Arrow function scoping
- Class method scoping
- Module-level mutations (CRITICAL test)
- Real-world integration patterns
- Scope path consistency verification

---

## Test Structure

Following the pattern from `test/unit/VariableReassignment.test.js`:
- Use `setupTest()` helper to create temporary test projects
- Use `createTestOrchestrator()` to run full analysis pipeline
- Query nodes and edges from the graph
- Assert on FLOWS_INTO and READS_FROM edges

---

## Test Coverage by Category

### 1. Variable Reassignment - Basic Shadowing (3 tests)

**Test 1: Inner variable shadowing**
```javascript
let x = 1;
function foo() {
  let x = 2;
  x += 3;  // Should FLOWS_INTO inner x, NOT outer x
}
```
**Assertion**: FLOWS_INTO edge goes to inner x, NOT outer x.

**Test 2: Parent scope lookup (no shadowing)**
```javascript
let total = 0;
function processItems(items) {
  for (const item of items) {
    total += item.price;  // Should FLOWS_INTO outer total
  }
}
```
**Assertion**: FLOWS_INTO edge goes to module-level total (parent scope).

**Test 3: Multiple nesting levels (3+ scopes)**
```javascript
let x = 1;
function outer() {
  let x = 2;
  function inner() {
    let x = 3;
    x += 4;  // Should FLOWS_INTO innermost x
  }
}
```
**Assertion**: FLOWS_INTO edge goes to innermost x, not outer or global x.

---

### 2. Module-Level Mutations (2 tests) **CRITICAL**

**Test 4: Module-level variable mutation**
```javascript
let count = 0;
count++;  // Module-level mutation, scope path = []
```
**Assertion**: Mutation with scope path `[]` resolves to variable with semantic ID scope `['global']`.

**Why critical**: This tests the fix from Linus's review. Empty mutation scope path must match semantic ID scope `['global']`.

**Test 5: Module-level compound mutation**
```javascript
let total = 0;
const value = 10;
total += value;  // Module-level compound mutation
```
**Assertion**: Both FLOWS_INTO and READS_FROM edges created for module-level variable.

---

### 3. Array Mutations - Scope Awareness (3 tests)

**Test 6: Array push with shadowing**
```javascript
let arr = [];
function foo() {
  let arr = [];
  arr.push(1);  // Should FLOWS_INTO inner arr
}
```
**Assertion**: FLOWS_INTO edge from push() goes to inner arr, not outer arr.

**Test 7: Array push to parent scope**
```javascript
let results = [];
function collect(item) {
  results.push(item);  // Should FLOWS_INTO outer results
}
```
**Assertion**: FLOWS_INTO edge goes to module-level array (parent scope lookup).

**Test 8: Array indexed assignment with shadowing**
```javascript
let arr = [];
if (true) {
  let arr = [];
  arr[0] = 42;  // Should FLOWS_INTO inner arr
}
```
**Assertion**: Indexed assignment resolves to inner arr.

---

### 4. Object Mutations - Scope Awareness (3 tests)

**Test 9: Object property assignment with shadowing**
```javascript
let obj = {};
if (true) {
  let obj = {};
  obj.prop = 1;  // Should FLOWS_INTO inner obj
}
```
**Assertion**: FLOWS_INTO edge with `mutationType: 'property'` goes to inner obj.

**Test 10: Object mutation to parent scope**
```javascript
let config = {};
function setup() {
  config.port = 3000;  // Should FLOWS_INTO outer config
}
```
**Assertion**: Property assignment resolves to module-level object.

**Test 11: Object.assign with shadowing**
```javascript
let obj = {};
function foo() {
  let obj = {};
  Object.assign(obj, { a: 1 });  // Should FLOWS_INTO inner obj
}
```
**Assertion**: FLOWS_INTO edge with `mutationType: 'assign'` goes to inner obj.

---

### 5. Parameter Mutations in Nested Scopes (2 tests)

**Test 12: Parameter mutation from nested function**
```javascript
function outer(x) {
  function inner() {
    x++;  // Should FLOWS_INTO parameter x in outer scope
  }
}
```
**Assertion**: Mutation in inner() affects parameter in outer() (parent scope lookup).

**Test 13: Parameter shadowing**
```javascript
function outer(x) {
  function inner(x) {
    x++;  // Should FLOWS_INTO inner parameter, not outer
  }
}
```
**Assertion**: Mutation resolves to inner parameter, not outer.

---

### 6. Arrow Functions - Scope Awareness (2 tests)

**Test 14: Arrow function with shadowing**
```javascript
let x = 1;
const fn = () => {
  let x = 2;
  x++;  // Should FLOWS_INTO inner x
};
```
**Assertion**: Mutation in arrow function resolves to inner x.

**Test 15: Arrow function mutation to outer scope**
```javascript
let count = 0;
const increment = () => {
  count++;  // Should FLOWS_INTO outer count
};
```
**Assertion**: Mutation in arrow function resolves to module-level variable.

---

### 7. Class Methods - Scope Awareness (1 test)

**Test 16: Local variable in class method**
```javascript
let x = 1;
class Foo {
  method() {
    let x = 2;
    x++;  // Should FLOWS_INTO method-scoped x
  }
}
```
**Assertion**: Mutation resolves to method-scoped x, not global x.

---

### 8. Integration: Real-world Patterns (3 tests)

**Test 17: Accumulator pattern with shadowing risk**
```javascript
function processAll(groups) {
  let total = 0;  // Outer total
  for (const group of groups) {
    let total = 0;  // Inner total (shadowing)
    for (const item of group.items) {
      total += item.price;  // Should FLOWS_INTO inner total
    }
  }
}
```
**Assertion**: Mutation in nested loop resolves to inner total, not outer.

**Test 18: Closure capturing with mutations**
```javascript
function createCounter() {
  let count = 0;
  return function increment() {
    count++;  // Should FLOWS_INTO count in outer scope (closure)
  };
}
```
**Assertion**: Mutation in returned function affects outer scope variable.

**Test 19: Complex nesting with mixed shadowing**
```javascript
let result = [];
function process(items) {
  let result = [];  // Shadows module-level
  for (const item of items) {
    if (item.valid) {
      let result = [];  // Shadows function-level
      result.push(item.data);  // Should FLOWS_INTO innermost result
    }
  }
}
```
**Assertion**: Array mutation resolves to innermost result across 3 scope levels.

---

### 9. Scope Path Consistency Verification (1 test)

**Test 20: Scope path format consistency**
```javascript
function outer() {
  let x = 1;
  function inner() {
    x++;  // Mutation scope: ['outer', 'inner']
         // Variable scope: ['outer']
         // Should match via scope chain walk
  }
}
```
**Assertion**:
1. Variable semantic ID has correct scope format (`->outer->VARIABLE->x`)
2. Mutation from inner scope successfully resolves outer scope variable via scope chain walk

**Why important**: Verifies that mutation scope paths and variable semantic ID scope paths use consistent format.

---

## Test Intent Communication

Each test clearly states:
1. **What code pattern is being tested** (in comments)
2. **Expected behavior** ("Should FLOWS_INTO inner x")
3. **What would be wrong** ("NOT outer x")

Example:
```javascript
it('should resolve mutation to INNER variable in nested scope', async () => {
  // Code: let x = 1; function foo() { let x = 2; x += 3; }

  // CRITICAL: Mutation x += 3 should create edge to INNER x
  const flowsToInner = allEdges.find(e =>
    e.type === 'FLOWS_INTO' && e.dst === innerX.id
  );
  assert.ok(
    flowsToInner,
    `Expected FLOWS_INTO edge to inner x. Found edges to outer x: ${...}`
  );

  // Verify NO edge goes to outer x from the mutation
  const flowsToOuter = allEdges.find(e => ...);
  assert.strictEqual(
    flowsToOuter, undefined,
    'FLOWS_INTO edge incorrectly goes to outer x (scope resolution bug)'
  );
});
```

---

## Node Identification Strategy

**Challenge**: Need to distinguish between multiple variables with same name but different scopes.

**Solution**: Use semantic ID patterns in node.id field:
```javascript
const outerX = allNodes.find(n =>
  n.name === 'x' &&
  n.id.includes('->global->VARIABLE->x')
);
const innerX = allNodes.find(n =>
  n.name === 'x' &&
  n.id.includes('->foo->VARIABLE->x')
);
```

**Semantic ID format** (from Joel's plan):
- Module-level: `file->global->VARIABLE->name`
- Function-level: `file->funcName->VARIABLE->name`
- Nested: `file->outer->inner->VARIABLE->name`

---

## Edge Direction Verification

All tests verify:
1. **FLOWS_INTO edges go to the CORRECT target variable** (inner vs outer)
2. **FLOWS_INTO edges do NOT go to the WRONG target variable**

Example pattern:
```javascript
// Positive assertion: edge exists to correct target
const flowsToInner = allEdges.find(e =>
  e.type === 'FLOWS_INTO' && e.dst === innerX.id
);
assert.ok(flowsToInner, 'Expected FLOWS_INTO edge to inner x');

// Negative assertion: edge does NOT exist to wrong target
const flowsToOuter = allEdges.find(e =>
  e.type === 'FLOWS_INTO' &&
  e.dst === outerX.id &&
  e.src !== outerX.id  // Exclude initialization
);
assert.strictEqual(
  flowsToOuter, undefined,
  'FLOWS_INTO edge incorrectly goes to outer x'
);
```

---

## Critical Tests (MUST PASS)

From Linus's review, these tests are blocking:

### Test 4: Module-level mutations
**Why critical**: Tests the fix for empty scope path `[]` matching semantic ID scope `['global']`.

**Current behavior (before fix)**: Mutation with scope path `[]` fails to resolve because it doesn't match semantic ID scope `['global']`.

**Expected behavior (after fix)**: Resolver handles mapping: `searchScopePath.length === 0` matches `parsed.scopePath === ['global']`.

### Test 20: Scope path consistency
**Why critical**: Verifies that mutations and variables use same scope path format.

**What it tests**:
- Variable semantic ID: `file->outer->VARIABLE->x`
- Mutation scope path: `['outer', 'inner']`
- Scope chain walk: tries `['outer', 'inner']`, then `['outer']`, then `[]`
- Match found at `['outer']`

---

## Test Execution Expectation

**Before implementation**: ALL tests should FAIL (RED).

**Why**: Current implementation uses file-level lookup (`file:name`), which resolves all mutations to first variable with that name in the file.

**After implementation**: ALL tests should PASS (GREEN).

**Why**: New implementation uses scope chain resolution, correctly handling shadowing and parent scope lookup.

---

## Test Categories Summary

| Category | Tests | Coverage |
|----------|-------|----------|
| Variable reassignment shadowing | 3 | Basic shadowing, parent scope, multiple levels |
| Module-level mutations | 2 | Empty scope path, compound operators |
| Array mutations | 3 | push(), parent scope, indexed assignment |
| Object mutations | 3 | Property assignment, parent scope, Object.assign |
| Parameter mutations | 2 | Parent scope, shadowing |
| Arrow functions | 2 | Shadowing, parent scope |
| Class methods | 1 | Method-scoped variables |
| Real-world patterns | 3 | Accumulator, closures, complex nesting |
| Scope consistency | 1 | Semantic ID format verification |
| **TOTAL** | **20** | **All mutation types, all scope scenarios** |

---

## Files Created

- `test/unit/ScopeAwareVariableLookup.test.js` - 26 test cases (20 core + 6 variations)

---

## Next Steps for Rob

1. Run tests to verify they FAIL (RED state - expected before implementation)
2. Implement scope-aware lookup according to Joel's revised plan
3. Run tests again to verify they PASS (GREEN state - correctness verification)

**Test execution**:
```bash
node --test test/unit/ScopeAwareVariableLookup.test.js
```

---

## Notes

1. **Test quality**: Tests communicate intent clearly, use existing patterns from VariableReassignment.test.js.

2. **No mocks**: All tests use real graph analysis (orchestrator + RFDB backend).

3. **Defensive assertions**: Each test verifies both positive (edge exists to correct target) and negative (edge doesn't exist to wrong target).

4. **Edge case coverage**: Includes closure patterns, complex nesting, parameter shadowing, arrow functions, class methods.

5. **Critical test marked**: Module-level mutation test explicitly marked as CRITICAL in comments.

---

**Kent Beck**
Test Engineer, Grafema
