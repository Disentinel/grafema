# Kent Beck - Test Report for REG-116

## Summary

I've written comprehensive tests for indexed array assignment detection BEFORE refactoring. However, testing revealed a critical finding: **the arrayMutations collection is populated correctly, but these mutations are never converted to FLOWS_INTO edges**.

## Test File Created

**Location**: `/Users/vadimr/grafema/test/unit/IndexedArrayAssignmentRefactoring.test.js`

## Test Coverage

The test file includes 12 test cases covering:

### Module-Level Indexed Assignment
1. ✅ `arr[0] = variable` - detects variable assignment
2. ✅ `arr[0] = 'literal'` - detects literal assignment
3. ✅ `arr[0] = { obj }` - detects object literal assignment
4. ✅ `arr[0] = [1,2,3]` - detects array literal assignment
5. ✅ `arr[0] = fn()` - detects call expression assignment

### Computed Index Assignment
6. ✅ `arr[index] = value` - detects computed index (variable)
7. ✅ `arr[i + 1] = value` - detects computed index (expression)

### Function-Level Assignment
8. ✅ Assignment inside function body with parameters
9. ✅ Assignment inside function body with local variables

### Mixed Contexts
10. ✅ Both module and function contexts in same file

### Edge Metadata
11. ✅ Verifies edge structure and metadata fields

### Multiple Assignments
12. ✅ Multiple assignments to same array create multiple edges

## Critical Finding: Missing Edge Creation

### Current Behavior

The code in JSASTAnalyzer.ts DOES collect arrayMutations correctly:

**Module level (lines 910-952):**
```typescript
AssignmentExpression: (assignPath) => {
  // Detects arr[i] = value
  // Collects ArrayMutationInfo
  arrayMutations.push({ ... });
}
```

**Function level (lines 1280-1332):**
```typescript
AssignmentExpression: (assignPath) => {
  // Identical logic
  arrayMutations.push({ ... });
}
```

### The Problem

**arrayMutations are collected but NEVER processed into FLOWS_INTO edges!**

Evidence:
1. Searched entire codebase - no code converts arrayMutations to edges
2. Existing `ArrayMutationTracking.test.js` has failing tests for indexed assignment
3. `CallExpressionVisitor.detectArrayMutation()` handles push/unshift/splice but those don't create edges either
4. No equivalent of "GraphBuilder processes arrayMutations" exists

### Comparison with Existing Tests

Running `ArrayMutationTracking.test.js`:
```bash
$ node --test test/unit/ArrayMutationTracking.test.js
❌ arr.push(obj) tests - FAIL
❌ arr.unshift(obj) tests - FAIL
❌ arr.splice(...) tests - FAIL
❌ arr[i] = obj tests - FAIL
```

**Critical discovery: ALL array mutation tests fail, not just indexed!**

The entire `arrayMutations` → `FLOWS_INTO` edges feature is unimplemented. The tests in `ArrayMutationTracking.test.js` were written to specify desired behavior, but the implementation doesn't exist yet.

## Test Strategy Clarification Needed

My tests currently verify FLOWS_INTO edges exist. This is the CORRECT expected behavior per the type definitions.

However, all 12 tests FAIL because no edges are created from arrayMutations (this affects ALL array mutation detection, not just indexed).

### Options:

**Option A: Keep tests as-is (recommended)**
- Tests specify CORRECT behavior (edges should exist)
- After refactoring REG-116, tests will still fail
- Reveals that edge creation is missing (separate bug)
- Someone needs to implement arrayMutations → FLOWS_INTO edges

**Option B: Modify tests to verify arrayMutations collection**
- Would need backend API to access arrayMutations
- No such API exists
- Would test internal implementation, not behavior
- Not TDD best practice

**Option C: Tests are "documentation of future behavior"**
- Write tests knowing they fail
- After BOTH refactoring AND implementing edge creation, they pass
- This is acceptable in TDD when revealing gaps

## Recommendation

**I recommend Option A** with the following action plan:

### For REG-116 (current task):
1. My tests remain as-is - they specify correct behavior
2. Tests will fail before AND after refactoring (expected)
3. Refactoring should preserve current behavior (no edges created)
4. Tests document the gap

### Separate task needed:
**New Issue: "Implement FLOWS_INTO edge creation from arrayMutations"**

The code collects arrayMutations but never processes them. Need to:
1. Find where edges are created (likely in GraphBuilder or post-processing)
2. Process all arrayMutations (push/unshift/splice/indexed) → create FLOWS_INTO edges
3. Both `ArrayMutationTracking.test.js` and my tests will then pass

**Note**: This is not just an indexed assignment issue - it's a missing feature for ALL array mutation methods.

## Test Pattern

Tests follow existing `ArrayMutationTracking.test.js` pattern:

```javascript
const allNodes = await backend.getAllNodes();
const allEdges = await backend.getAllEdges();

const arrVar = allNodes.find(n => n.name === 'arr');
const valueVar = allNodes.find(n => n.name === 'value');

const flowsInto = allEdges.find(e =>
  e.type === 'FLOWS_INTO' &&
  e.src === valueVar.id &&
  e.dst === arrVar.id
);

assert.ok(flowsInto, 'Expected FLOWS_INTO edge');
assert.strictEqual(flowsInto.mutationMethod, 'indexed');
assert.strictEqual(flowsInto.argIndex, 0);
```

This is the CORRECT way to test - verify observable behavior (edges in graph), not internal implementation details.

## Current Test Status

```
❌ All 12 tests FAIL
Reason: No FLOWS_INTO edges created from arrayMutations
Expected after REG-116: Still fail (refactoring preserves behavior)
Will pass after: Implementing arrayMutations → edges conversion
```

## Files

- **Test file**: `/Users/vadimr/grafema/test/unit/IndexedArrayAssignmentRefactoring.test.js`
- **Verified existing**: `/Users/vadimr/grafema/test/unit/ArrayMutationTracking.test.js` (indexed tests also fail)

## Next Steps

1. **Clarify intent**: Should REG-116 ALSO implement edge creation? Or is that separate?
2. **If separate**: My tests are complete, proceed to implementation
3. **If combined**: Need to expand scope to include edge creation logic

**Awaiting direction before proceeding to implementation phase.**

---

*Kent Beck*
*"Test first. Always."*
