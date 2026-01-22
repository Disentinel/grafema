# Kent Beck - Test Report for REG-131

## Tests Written

Created test file: `/Users/vadimr/grafema/test/unit/ClassMethodSemanticId.test.js`

### Test Categories

1. **Class method should have semantic ID format** (2 tests)
   - `should produce semantic ID for regular class method`
   - `should produce semantic ID for multiple methods in same class`

2. **Class property function should have semantic ID** (2 tests)
   - `should produce semantic ID for arrow function class property`
   - `should produce semantic ID for multiple arrow function properties`

3. **Constructor should have semantic ID** (2 tests)
   - `should produce semantic ID for constructor`
   - `should produce semantic ID for constructor with parameters`

4. **Static method should have semantic ID** (2 tests)
   - `should produce semantic ID for static method`
   - `should produce semantic ID for multiple static methods`

5. **Getter/setter should have semantic ID** (3 tests)
   - `should produce semantic ID for getter`
   - `should produce semantic ID for setter`
   - `should handle getter and setter pair`

6. **No FUNCTION# prefix in any class method output** (2 tests)
   - `should have NO function IDs starting with FUNCTION# in class with multiple method types`
   - `should have NO FUNCTION# IDs when analyzing multiple classes`

7. **CONTAINS edges should use matching function IDs** (2 tests)
   - `should have CONTAINS edges with semantic function IDs`
   - `should have CALL nodes with correct parentScopeId matching function semantic ID`

8. **Semantic ID stability** (1 test)
   - `should produce same ID when class method moves to different line`

---

## Test Results (Before Implementation)

```
# tests 16
# pass 2
# fail 14
```

### Summary of Failures

All class method tests fail as expected (TDD). The error messages clearly show the issue:

```
error: 'Method should have semantic ID format. Got: FUNCTION#UserService.getUser#/path/to/index.js#3:2'
```

**Current format (legacy):**
```
FUNCTION#ClassName.methodName#/full/path/to/file.js#line:column
```

**Expected format (semantic):**
```
index.js->ClassName->FUNCTION->methodName
```

### Passing Tests

2 tests pass:
1. `should have CONTAINS edges with semantic function IDs` - Tests top-level functions (not class methods), which already use semantic IDs via `FunctionVisitor`
2. `should have CALL nodes with correct parentScopeId matching function semantic ID` - Same reason

---

## What Needs to be Implemented

### Files to Modify

Based on the approved plan (005-don-revised-plan.md) and Linus's review (006-linus-re-review.md):

1. **`ClassVisitor.ts`** - Lines 246, 307, 252, 313
   - Change `functionId` generation for class methods to use semantic IDs
   - Pattern to follow: `FunctionVisitor.ts` lines 288-290

2. **`CallExpressionVisitor.ts`** - Line 996 (not 910 as originally stated)
   - Fix `getFunctionScopeId()` to match semantic format
   - Critical: CONTAINS edges will be orphaned if this doesn't match

3. **`JSASTAnalyzer.ts`** - Lines 900, 970, 1660, 1714
   - Nested functions and module-level functions

4. **`SocketIOAnalyzer.ts`** - Line 312
   - Handler function lookup

### Implementation Pattern

From `FunctionVisitor.ts`:
```typescript
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', name, scopeTracker.getContext())
  : legacyId;
```

---

## TDD Status

**GREEN**: Tests are correctly failing before implementation.

Next step: Rob Pike implements the changes to make these tests pass.

---

## Run Command

```bash
node --test test/unit/ClassMethodSemanticId.test.js
```
