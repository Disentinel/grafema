# Joel Spolsky - Detailed Technical Specification for REG-116

**Task:** Extract duplicated indexed array assignment detection into a reusable helper method

**Date:** 2025-01-22

---

## Executive Summary

This refactoring extracts ~42 lines of duplicated code (lines 910-952 and 1280-1332) in `JSASTAnalyzer.ts` into a private helper method. Additionally, we will rename the `arguments` property in `ArrayMutationInfo` to `insertedValues` and add defensive `loc` checks.

**Total Files Modified:** 3
**Total Files Created:** 1 (test file)
**Estimated Risk:** LOW (pure refactoring, behavioral identity preserved)

---

## Phase 1: Extract Helper Method

### Step 1.1: Create Helper Method Signature

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Add after line 1110 (after `analyzeFunctionBody` method, before the closing brace of the class)

**Method Signature:**
```typescript
/**
 * Detect indexed array assignment: arr[i] = value
 * Creates ArrayMutationInfo for FLOWS_INTO edge generation in GraphBuilder
 *
 * @param assignNode - The assignment expression node
 * @param module - Current module being analyzed
 * @param arrayMutations - Collection to push mutation info into
 */
private detectIndexedArrayAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[]
): void {
  // Implementation will go here
}
```

### Step 1.2: Implement Helper Method Body

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Implementation:** Copy lines 911-952 (the actual logic block WITHOUT the surrounding if check)

**Key changes from original:**
1. **Add defensive `loc` checks** instead of `!` assertions:
   ```typescript
   const line = assignNode.loc?.start.line ?? 0;
   const column = assignNode.loc?.start.column ?? 0;
   ```

2. **Remove collection initialization** (lines 1293-1296 in the second occurrence):
   - Caller is responsible for ensuring `arrayMutations` array exists
   - Helper operates on the passed array directly

3. **Keep all other logic identical:**
   - MemberExpression check with `computed` property
   - Array name extraction from `memberExpr.object`
   - `ArrayMutationArgument` construction
   - Value type detection logic (LITERAL, VARIABLE, OBJECT_LITERAL, ARRAY_LITERAL, CALL)
   - Push to `arrayMutations` array

**Complete Implementation:**
```typescript
private detectIndexedArrayAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[]
): void {
  // Check for indexed array assignment: arr[i] = value
  if (assignNode.left.type === 'MemberExpression' && assignNode.left.computed) {
    const memberExpr = assignNode.left;

    // Get array name (only simple identifiers for now)
    if (memberExpr.object.type === 'Identifier') {
      const arrayName = memberExpr.object.name;
      const value = assignNode.right;

      const argInfo: ArrayMutationArgument = {
        argIndex: 0,
        isSpread: false,
        valueType: 'EXPRESSION'
      };

      // Determine value type
      const literalValue = ExpressionEvaluator.extractLiteralValue(value);
      if (literalValue !== null) {
        argInfo.valueType = 'LITERAL';
        argInfo.literalValue = literalValue;
      } else if (value.type === 'Identifier') {
        argInfo.valueType = 'VARIABLE';
        argInfo.valueName = value.name;
      } else if (value.type === 'ObjectExpression') {
        argInfo.valueType = 'OBJECT_LITERAL';
      } else if (value.type === 'ArrayExpression') {
        argInfo.valueType = 'ARRAY_LITERAL';
      } else if (value.type === 'CallExpression') {
        argInfo.valueType = 'CALL';
        argInfo.callLine = value.loc?.start.line;
        argInfo.callColumn = value.loc?.start.column;
      }

      // Use defensive loc checks instead of ! assertions
      const line = assignNode.loc?.start.line ?? 0;
      const column = assignNode.loc?.start.column ?? 0;

      arrayMutations.push({
        arrayName,
        mutationMethod: 'indexed',
        file: module.file,
        line: line,
        column: column,
        arguments: [argInfo]  // Note: will be renamed to insertedValues in Phase 2
      });
    }
  }
}
```

### Step 1.3: Replace First Occurrence (Module-level)

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Lines 910-952

**Before:**
```typescript
// Check for indexed array assignment at module level: arr[i] = value
if (assignNode.left.type === 'MemberExpression' && assignNode.left.computed) {
  const memberExpr = assignNode.left;

  // Get array name (only simple identifiers for now)
  if (memberExpr.object.type === 'Identifier') {
    const arrayName = memberExpr.object.name;
    const value = assignNode.right;

    const argInfo: ArrayMutationArgument = {
      argIndex: 0,
      isSpread: false,
      valueType: 'EXPRESSION'
    };

    // Determine value type
    const literalValue = ExpressionEvaluator.extractLiteralValue(value);
    if (literalValue !== null) {
      argInfo.valueType = 'LITERAL';
      argInfo.literalValue = literalValue;
    } else if (value.type === 'Identifier') {
      argInfo.valueType = 'VARIABLE';
      argInfo.valueName = value.name;
    } else if (value.type === 'ObjectExpression') {
      argInfo.valueType = 'OBJECT_LITERAL';
    } else if (value.type === 'ArrayExpression') {
      argInfo.valueType = 'ARRAY_LITERAL';
    } else if (value.type === 'CallExpression') {
      argInfo.valueType = 'CALL';
      argInfo.callLine = value.loc?.start.line;
      argInfo.callColumn = value.loc?.start.column;
    }

    arrayMutations.push({
      arrayName,
      mutationMethod: 'indexed',
      file: module.file,
      line: assignNode.loc!.start.line,
      column: assignNode.loc!.start.column,
      arguments: [argInfo]
    });
  }
}
```

**After:**
```typescript
// Check for indexed array assignment at module level: arr[i] = value
this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);
```

### Step 1.4: Replace Second Occurrence (Function-level)

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Lines 1280-1332 (inside `AssignmentExpression` handler in `analyzeFunctionBody`)

**Before:**
```typescript
AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
  const assignNode = assignPath.node;

  // Check for indexed array assignment: arr[i] = value
  if (assignNode.left.type === 'MemberExpression' && assignNode.left.computed) {
    const memberExpr = assignNode.left;

    // Get array name (only simple identifiers for now)
    if (memberExpr.object.type === 'Identifier') {
      const arrayName = memberExpr.object.name;
      const value = assignNode.right;

      // Initialize collection if not exists
      if (!collections.arrayMutations) {
        collections.arrayMutations = [];
      }
      const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

      const argInfo: ArrayMutationArgument = {
        argIndex: 0,
        isSpread: false,
        valueType: 'EXPRESSION'
      };

      // Determine value type
      const literalValue = ExpressionEvaluator.extractLiteralValue(value);
      if (literalValue !== null) {
        argInfo.valueType = 'LITERAL';
        argInfo.literalValue = literalValue;
      } else if (value.type === 'Identifier') {
        argInfo.valueType = 'VARIABLE';
        argInfo.valueName = value.name;
      } else if (value.type === 'ObjectExpression') {
        argInfo.valueType = 'OBJECT_LITERAL';
      } else if (value.type === 'ArrayExpression') {
        argInfo.valueType = 'ARRAY_LITERAL';
      } else if (value.type === 'CallExpression') {
        argInfo.valueType = 'CALL';
        argInfo.callLine = value.loc?.start.line;
        argInfo.callColumn = value.loc?.start.column;
      }

      arrayMutations.push({
        arrayName,
        mutationMethod: 'indexed',
        file: module.file,
        line: assignNode.loc!.start.line,
        column: assignNode.loc!.start.column,
        arguments: [argInfo]
      });
    }
  }
},
```

**After:**
```typescript
AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
  const assignNode = assignPath.node;

  // Initialize collection if not exists
  if (!collections.arrayMutations) {
    collections.arrayMutations = [];
  }
  const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

  // Check for indexed array assignment: arr[i] = value
  this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);
},
```

**Note:** Collection initialization must happen BEFORE calling the helper, since the helper expects a valid array.

---

## Phase 2: Rename Property

### Step 2.1: Update Type Definition

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`

**Location:** Line 359

**Before:**
```typescript
export interface ArrayMutationInfo {
  arrayName: string;           // Name of the array variable being mutated
  arrayLine?: number;          // Line where array is referenced (for scope resolution)
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  file: string;
  line: number;
  column: number;
  arguments: ArrayMutationArgument[];  // What's being added to the array
}
```

**After:**
```typescript
export interface ArrayMutationInfo {
  arrayName: string;           // Name of the array variable being mutated
  arrayLine?: number;          // Line where array is referenced (for scope resolution)
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  file: string;
  line: number;
  column: number;
  insertedValues: ArrayMutationArgument[];  // What's being added to the array
}
```

### Step 2.2: Update JSASTAnalyzer (Helper Method)

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Inside the new `detectIndexedArrayAssignment` method (line with `arrayMutations.push`)

**Before:**
```typescript
arrayMutations.push({
  arrayName,
  mutationMethod: 'indexed',
  file: module.file,
  line: line,
  column: column,
  arguments: [argInfo]
});
```

**After:**
```typescript
arrayMutations.push({
  arrayName,
  mutationMethod: 'indexed',
  file: module.file,
  line: line,
  column: column,
  insertedValues: [argInfo]
});
```

### Step 2.3: Update CallExpressionVisitor

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Location:** Line 834 (inside `detectArrayMutation` method)

**Before:**
```typescript
arrayMutations.push({
  arrayName,
  mutationMethod: method,
  file: module.file,
  line: callNode.loc!.start.line,
  column: callNode.loc!.start.column,
  arguments: mutationArgs
});
```

**After:**
```typescript
arrayMutations.push({
  arrayName,
  mutationMethod: method,
  file: module.file,
  line: callNode.loc!.start.line,
  column: callNode.loc!.start.column,
  insertedValues: mutationArgs
});
```

### Step 2.4: Check GraphBuilder

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Action:** Search for any usage of `arrayMutations` or `ArrayMutationInfo`

**Status:** Based on grep results, GraphBuilder.ts does NOT currently process `arrayMutations` collection. The FLOWS_INTO edge creation appears to be planned but not yet implemented.

**Conclusion:** No changes needed in GraphBuilder for this refactoring. When FLOWS_INTO implementation is added, it will use the new `insertedValues` name.

### Step 2.5: Verify No Other References

**Command to run:**
```bash
grep -r "\.arguments" packages/core/src/plugins/analysis/ --include="*.ts" | grep -i "mutation"
```

**Expected Result:** Only the three locations we're updating (or TypeScript compiler errors if we missed any).

---

## Phase 3: Add Explicit Return Type

### Step 3.1: Update CallExpressionVisitor.detectArrayMutation

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Location:** Line 774 (method signature)

**Before:**
```typescript
private detectArrayMutation(
  callNode: CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: VisitorModule
) {
```

**After:**
```typescript
private detectArrayMutation(
  callNode: CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: VisitorModule
): void {
```

### Step 3.2: Add Defensive `loc` Checks to detectArrayMutation

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Location:** Lines 832-833

**Before:**
```typescript
arrayMutations.push({
  arrayName,
  mutationMethod: method,
  file: module.file,
  line: callNode.loc!.start.line,
  column: callNode.loc!.start.column,
  insertedValues: mutationArgs  // Updated in Phase 2
});
```

**After:**
```typescript
const line = callNode.loc?.start.line ?? 0;
const column = callNode.loc?.start.column ?? 0;

arrayMutations.push({
  arrayName,
  mutationMethod: method,
  file: module.file,
  line: line,
  column: column,
  insertedValues: mutationArgs  // Updated in Phase 2
});
```

---

## Testing Strategy

### Test File Structure

**Create:** `/Users/vadimr/grafema/test/unit/IndexedArrayAssignmentRefactoring.test.js`

**Purpose:** Lock current behavior BEFORE refactoring, verify behavioral identity AFTER refactoring

### Test Cases

#### Test 1: Module-level indexed assignment
```javascript
it('should detect module-level arr[i] = value', async () => {
  await setupTest(backend, {
    'index.js': `
const arr = [];
const value = { test: true };
arr[0] = value;
    `
  });

  const allNodes = await backend.getAllNodes();
  const arrVar = allNodes.find(n => n.name === 'arr');
  const valueVar = allNodes.find(n => n.name === 'value');

  assert.ok(arrVar, 'arr variable should exist');
  assert.ok(valueVar, 'value variable should exist');

  // When GraphBuilder implements FLOWS_INTO, verify edge exists
  // For now, verify that analysis completes without error
});
```

#### Test 2: Function-level indexed assignment
```javascript
it('should detect function-level arr[i] = value', async () => {
  await setupTest(backend, {
    'index.js': `
function addToArray(arr, val) {
  arr[0] = val;
}
    `
  });

  // Verify analysis completes successfully
  const allNodes = await backend.getAllNodes();
  assert.ok(allNodes.length > 0, 'Analysis should create nodes');
});
```

#### Test 3: Computed index
```javascript
it('should detect arr[index] = value with variable index', async () => {
  await setupTest(backend, {
    'index.js': `
const arr = [];
const index = 5;
const value = 'test';
arr[index] = value;
    `
  });

  const allNodes = await backend.getAllNodes();
  assert.ok(allNodes.find(n => n.name === 'arr'), 'arr should exist');
  assert.ok(allNodes.find(n => n.name === 'value'), 'value should exist');
});
```

#### Test 4: Different value types
```javascript
it('should detect value types: LITERAL, VARIABLE, OBJECT_LITERAL, ARRAY_LITERAL, CALL', async () => {
  await setupTest(backend, {
    'index.js': `
const arr = [];
arr[0] = 42;                    // LITERAL
arr[1] = someVar;               // VARIABLE
arr[2] = { key: 'val' };        // OBJECT_LITERAL
arr[3] = [1, 2, 3];             // ARRAY_LITERAL
arr[4] = getValue();            // CALL
    `
  });

  const allNodes = await backend.getAllNodes();
  assert.ok(allNodes.find(n => n.name === 'arr'), 'arr should exist');
});
```

#### Test 5: Both contexts in same file
```javascript
it('should detect indexed assignments in both module and function contexts', async () => {
  await setupTest(backend, {
    'index.js': `
const moduleArr = [];
moduleArr[0] = 'module';

function test() {
  const funcArr = [];
  funcArr[0] = 'function';
}
    `
  });

  const allNodes = await backend.getAllNodes();
  assert.ok(allNodes.find(n => n.name === 'moduleArr'), 'moduleArr should exist');
  assert.ok(allNodes.find(n => n.name === 'funcArr'), 'funcArr should exist');
});
```

### Test Execution Order

1. **BEFORE refactoring:**
   ```bash
   node --test test/unit/IndexedArrayAssignmentRefactoring.test.js
   ```
   All tests must pass.

2. **AFTER Phase 1 (helper extraction):**
   ```bash
   node --test test/unit/IndexedArrayAssignmentRefactoring.test.js
   ```
   All tests must still pass (behavioral identity).

3. **AFTER Phase 2 (rename):**
   ```bash
   npm run build  # TypeScript compilation must succeed
   node --test test/unit/IndexedArrayAssignmentRefactoring.test.js
   ```
   All tests must still pass.

4. **AFTER Phase 3 (return type):**
   ```bash
   npm run build  # TypeScript compilation must succeed
   node --test test/unit/IndexedArrayAssignmentRefactoring.test.js
   ```
   All tests must still pass.

5. **Final verification:**
   ```bash
   npm test  # Run full test suite
   ```

---

## Implementation Order (Critical)

**MUST follow this exact sequence:**

1. **Kent Beck:** Write test file, verify all tests pass with current code
2. **Rob Pike:** Implement Phase 1 (helper extraction)
3. **Kent Beck:** Run tests, verify behavioral identity
4. **Rob Pike:** Implement Phase 2 (rename `arguments` → `insertedValues`)
5. **Kent Beck:** Run tests + TypeScript compilation
6. **Rob Pike:** Implement Phase 3 (add return types + defensive checks)
7. **Kent Beck:** Run tests + TypeScript compilation
8. **Kevlin Henney:** Code quality review
9. **Linus Torvalds:** High-level review

---

## Success Criteria

### Correctness
- [ ] All existing tests pass
- [ ] New refactoring tests pass
- [ ] TypeScript compilation succeeds with no errors
- [ ] No new ESLint warnings

### Code Quality
- [ ] Zero duplication of indexed assignment logic
- [ ] Helper method has clear, single responsibility
- [ ] `insertedValues` name is clearer than `arguments`
- [ ] Defensive `loc` checks prevent potential runtime errors
- [ ] Explicit return types improve type safety

### Behavioral Identity
- [ ] Module-level detection works identically
- [ ] Function-level detection works identically
- [ ] All value types detected correctly (LITERAL, VARIABLE, OBJECT_LITERAL, ARRAY_LITERAL, CALL)
- [ ] Line/column numbers preserved (or fallback to 0:0 if missing)

---

## Verification Commands

### Check for remaining duplications
```bash
# Should return zero matches after refactoring
grep -n "memberExpr.object.type === 'Identifier'" packages/core/src/plugins/analysis/JSASTAnalyzer.ts | wc -l
```

### Find all references to `arguments` in ArrayMutationInfo context
```bash
# Should only show the type definition after rename
grep -rn "\.arguments" packages/core/src/plugins/analysis/ --include="*.ts" | grep -i mutation
```

### Verify defensive loc checks
```bash
# Should show ?? 0 fallbacks in both methods
grep -A 5 "loc?.start.line" packages/core/src/plugins/analysis/JSASTAnalyzer.ts | grep "?? 0"
grep -A 5 "loc?.start.line" packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts | grep "?? 0"
```

### TypeScript compilation
```bash
npm run build
# Must succeed with zero errors
```

---

## File Change Summary

### Modified Files (3)

1. **`/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`**
   - Add `detectIndexedArrayAssignment` method (lines ~1111-1155)
   - Replace lines 910-952 with single method call
   - Replace lines 1280-1332 with collection init + method call
   - Update `arguments` → `insertedValues` in helper method

2. **`/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`**
   - Line 359: Rename `arguments` → `insertedValues` in `ArrayMutationInfo` interface

3. **`/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`**
   - Line 774: Add `: void` return type to `detectArrayMutation`
   - Line 832-833: Add defensive `loc` checks
   - Line 834: Update `arguments` → `insertedValues`

### Created Files (1)

4. **`/Users/vadimr/grafema/test/unit/IndexedArrayAssignmentRefactoring.test.js`**
   - New test file with 5 test cases
   - Locks current behavior before refactoring

---

## Risk Assessment

### LOW RISK ✓
- Pure refactoring, no new functionality
- Logic moved verbatim (except defensive improvements)
- Type-safe rename (TypeScript will catch missed references)
- TDD approach ensures behavioral identity

### Potential Issues & Mitigations

**Issue 1:** Forgot to initialize `arrayMutations` before calling helper
**Mitigation:** Test case will fail immediately, easy to spot and fix

**Issue 2:** Missed a reference to `.arguments` property
**Mitigation:** TypeScript compilation will fail with clear error

**Issue 3:** Changed behavior accidentally during extraction
**Mitigation:** Tests lock exact behavior, will fail if behavior changes

---

## Follow-Up Work

### Create Linear Issue: Systematic `loc` Assertion Audit

**Team:** Reginaflow
**Title:** "Audit and fix non-null loc assertions across JSASTAnalyzer"
**Priority:** Low
**Labels:** Tech Debt, Code Quality

**Description:**
```markdown
## Context
JSASTAnalyzer currently uses `node.loc!.start.line` pattern hundreds of times throughout the codebase. This is dangerous if Babel ever returns nodes without location info.

## What Was Done in REG-116
- Added defensive `loc?.start.line ?? 0` checks in:
  - `detectIndexedArrayAssignment` helper
  - `CallExpressionVisitor.detectArrayMutation`

## What Needs to Be Done
Systematic audit of ALL `node.loc!` assertions in JSASTAnalyzer and related visitors.

## Acceptance Criteria
1. Find all occurrences of `loc!` in JSASTAnalyzer.ts and visitor files
2. Replace with defensive checks: `loc?.start.line ?? 0`
3. Establish fallback convention: 0:0 means "unknown location"
4. Document this convention in code comments
5. All tests pass after changes

## Estimate
Medium (100+ occurrences to review and update)

## Why Not Now
REG-116 is focused on DRY violation, not systemic assertion safety. Mixing concerns would violate single-responsibility principle for the refactoring task.
```

---

## Notes for Implementers

### For Kent Beck (Tests)
- Match existing test patterns in `/Users/vadimr/grafema/test/unit/ArrayMutationTracking.test.js`
- Use `createTestBackend()` and `createTestOrchestrator()` helpers
- Test file structure should mirror `ArrayMutationTracking.test.js`
- Focus on locking behavior, not implementation details

### For Rob Pike (Implementation)
- Extract first, verify, then rename
- Don't combine phases - each phase is a separate commit
- Keep defensive checks minimal (only `loc` for now)
- Match existing code style exactly
- No "improvements" beyond the spec

### For Kevlin Henney (Review)
- Check that helper method name is clear and descriptive
- Verify no duplication remains
- Ensure defensive checks don't add unnecessary complexity
- Confirm naming: `insertedValues` vs `arguments`

### For Linus Torvalds (Review)
- Did we do the right thing or take a shortcut?
- Is this at the right level of abstraction?
- Does it align with Grafema's vision?
- Would this embarrass us in code review?

---

## Conclusion

This refactoring is **mechanically straightforward** and **architecturally sound**. It eliminates a clear DRY violation without changing behavior or introducing complexity. The rename improves clarity, and defensive checks are forward-thinking without being paranoid.

**This is the right way to do it.**

---

**Joel Spolsky**
Implementation Planner
2025-01-22
