# REG-117: Nested Array Mutations - Test Report

**Author:** Kent Beck (Test Engineer)
**Date:** 2025-01-23
**Status:** Tests Ready (RED phase - awaiting implementation)

---

## Summary

Created comprehensive TDD test suite for REG-117 at:
`/Users/vadimr/grafema/test/unit/NestedArrayMutations.test.js`

The tests are currently **RED** as expected - they define the expected behavior before implementation.

---

## Test Results

```
# tests 20
# suites 11
# pass 8
# fail 12
```

### Passing Tests (8)
These tests verify **out-of-scope** behavior that should NOT create edges:
- Computed property: `obj[key].push(item)` - no edge (correct)
- Function return: `getArray().push(item)` - no edge (correct)
- Multi-level nesting: `obj.a.b.push(item)` - no edge (correct)
- `this.items.push()` fails silently - documented limitation (correct)
- Event handler multi-level pattern - doesn't crash (correct)
- Mixed scenarios documentation tests

### Failing Tests (12)
These tests define the **expected behavior** after implementation:
1. Simple nested mutation: `obj.arr.push(item)` - needs FLOWS_INTO edge
2. Nested with separate declaration - needs edge
3. Multiple arguments with argIndex - needs 3 edges
4. Spread operator with isSpread flag - needs edge
5. Mixed arguments with spread - needs 3 edges
6. Direct mutation regression - should still work
7. Both direct and nested in same file - both need edges
8. Nested unshift - needs edge
9. Nested splice - needs edge
10. Function-level nested mutations - needs edges
11. Arrow function nested mutations - needs edges
12. Reducer pattern (real-world) - needs edges

---

## Test Structure

### Test Categories

| Category | Tests | Purpose |
|----------|-------|---------|
| Simple nested mutation | 2 | Core `obj.arr.push(item)` pattern |
| `this.items.push()` | 2 | Class method pattern (documents limitation) |
| Multiple arguments | 1 | Correct argIndex for `push(a, b, c)` |
| Spread operator | 2 | isSpread flag for `push(...items)` |
| Regression | 2 | Direct `arr.push(item)` still works |
| Other mutation methods | 3 | `unshift()` and `splice()` variants |
| Out of scope | 3 | Computed, function return, multi-level |
| Edge metadata | 1 | nestedProperty in metadata |
| Function-level | 2 | Inside regular and arrow functions |
| Real-world scenarios | 2 | Reducer pattern, event emitter |

### Test Patterns Used

Following existing patterns from `ArrayMutationTracking.test.js`:

```javascript
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// Setup with temporary project
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-nested-array-${Date.now()}-${testCounter++}`);
  // ... create files, run orchestrator
}

// Test structure
describe('Nested Array Mutation Tracking (REG-117)', () => {
  let backend;
  beforeEach(async () => {
    backend = createTestBackend();
    await backend.connect();
  });
  after(async () => { await backend.cleanup(); });

  it('should create FLOWS_INTO edge from item to base object', async () => {
    await setupTest(backend, { 'index.js': `...` });
    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();
    // Assert edge exists with correct metadata
  });
});
```

---

## Key Test Scenarios

### 1. Core Pattern: `obj.arr.push(item)`
```javascript
const obj = { arr: [] };
const item = 'test';
obj.arr.push(item);
// Expected: FLOWS_INTO edge from 'item' to 'obj' (not 'arr')
```

### 2. `this.property.push()` (Documented Limitation)
```javascript
class Service {
  addItem(item) {
    this.items.push(item);
  }
}
// Expected: No edge - 'this' is not a variable node
// This is a documented limitation, not a bug
```

### 3. Multiple Arguments
```javascript
data.list.push(a, b, c);
// Expected: 3 FLOWS_INTO edges with argIndex 0, 1, 2
```

### 4. Spread Operator
```javascript
container.elements.push(...newItems);
// Expected: FLOWS_INTO edge with isSpread: true
```

### 5. Regression (Direct Mutations)
```javascript
const arr = [];
arr.push(item);
// Expected: Still creates FLOWS_INTO edge (no regression)
```

### 6. Out of Scope (No Edges Expected)
```javascript
obj[key].push(item);      // Computed property
getArray().push(item);    // Function return
obj.a.b.push(item);       // Multi-level nesting
```

---

## Edge Metadata Expectations

Per Joel's plan, edges should include:

```javascript
{
  type: 'FLOWS_INTO',
  src: '<item-variable-id>',
  dst: '<base-object-variable-id>',
  mutationMethod: 'push' | 'unshift' | 'splice',
  argIndex: 0,  // position in arguments
  isSpread: true,  // if spread operator used
  metadata: {
    nestedProperty: 'arr'  // optional, for debugging
  }
}
```

---

## Implementation Checklist

For Rob (Implementation):

- [ ] Tests in `test/unit/NestedArrayMutations.test.js` should turn GREEN
- [ ] All 12 failing tests must pass after implementation
- [ ] All 8 passing tests must remain passing (no regressions)
- [ ] Run existing `ArrayMutationTracking.test.js` to verify no regressions

---

## Running Tests

```bash
# Run only nested array mutation tests
node --test test/unit/NestedArrayMutations.test.js

# Run all array mutation tests (includes regression check)
node --test test/unit/ArrayMutationTracking.test.js test/unit/NestedArrayMutations.test.js
```

---

## Notes

1. **TDD Discipline**: Tests written BEFORE implementation, currently RED
2. **Followed existing patterns**: Matched style from `ArrayMutationTracking.test.js`
3. **Documented limitations**: `this.property.push()` cannot be resolved (no 'this' node)
4. **Out-of-scope tests**: Explicitly verify computed properties and multi-level nesting don't create edges
5. **Real-world scenarios**: Included Redux-like reducer pattern for practical validation
