# Joel Spolsky - Technical Implementation Plan: REG-134 Class Parameter Nodes

## Executive Summary

This plan details the exact steps to add PARAMETER node creation for class constructors and methods. The implementation follows Don's architectural decision to extract `createParameterNodes()` into a shared utility, then use it in both FunctionVisitor (refactor) and ClassVisitor (new feature).

**Estimated effort:** 2-3 hours
**Risk level:** Low (well-tested pattern, straightforward extraction)
**Files modified:** 3 core files + 2 test files + 1 new utility file + 1 new test fixture

---

## Step-by-Step Implementation

### STEP 1: Create Shared Utility Function

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts` (NEW)

**Purpose:** Extract the parameter creation logic from FunctionVisitor into a reusable utility.

**Full file contents:**

```typescript
/**
 * createParameterNodes - Shared utility for creating PARAMETER nodes
 *
 * Used by FunctionVisitor and ClassVisitor to create PARAMETER nodes
 * for function/method parameters with consistent behavior.
 */

import type {
  Node,
  Identifier,
  AssignmentPattern,
  RestElement
} from '@babel/types';
import type { ParameterInfo } from '../types.js';

/**
 * Create PARAMETER nodes for function parameters
 *
 * Handles:
 * - Simple Identifier parameters: function(a, b)
 * - AssignmentPattern (default parameters): function(a = 1)
 * - RestElement (rest parameters): function(...args)
 *
 * Does NOT handle (can be added later):
 * - ObjectPattern (destructuring): function({ x, y })
 * - ArrayPattern (destructuring): function([a, b])
 *
 * @param params - AST nodes for function parameters
 * @param functionId - ID of the parent function (for parentFunctionId field)
 * @param file - File path
 * @param line - Line number of the function (used for legacy ID generation)
 * @param parameters - Array to push ParameterInfo objects into
 */
export function createParameterNodes(
  params: Node[],
  functionId: string,
  file: string,
  line: number,
  parameters: ParameterInfo[]
): void {
  if (!parameters) return; // Guard for backward compatibility

  params.forEach((param, index) => {
    // Handle different parameter types
    if (param.type === 'Identifier') {
      const paramId = `PARAMETER#${param.name}#${file}#${line}:${index}`;
      parameters.push({
        id: paramId,
        type: 'PARAMETER',
        name: param.name,
        file: file,
        line: param.loc?.start.line || line,
        index: index,
        parentFunctionId: functionId
      });
    } else if (param.type === 'AssignmentPattern') {
      // Default parameter: function(a = 1)
      const assignmentParam = param as AssignmentPattern;
      if (assignmentParam.left.type === 'Identifier') {
        const paramId = `PARAMETER#${assignmentParam.left.name}#${file}#${line}:${index}`;
        parameters.push({
          id: paramId,
          type: 'PARAMETER',
          name: assignmentParam.left.name,
          file: file,
          line: assignmentParam.left.loc?.start.line || line,
          index: index,
          hasDefault: true,
          parentFunctionId: functionId
        });
      }
    } else if ((param as Node).type === 'RestElement') {
      // Rest parameter: function(...args)
      const restParam = param as unknown as RestElement;
      if (restParam.argument.type === 'Identifier') {
        const paramId = `PARAMETER#${restParam.argument.name}#${file}#${line}:${index}`;
        parameters.push({
          id: paramId,
          type: 'PARAMETER',
          name: restParam.argument.name,
          file: file,
          line: restParam.argument.loc?.start.line || line,
          index: index,
          isRest: true,
          parentFunctionId: functionId
        });
      }
    }
    // ObjectPattern and ArrayPattern (destructuring parameters) can be added later
  });
}
```

**Why this approach:**
- Pure function with no closure dependencies
- Takes `parameters` array explicitly (no side effects)
- Matches the exact logic from FunctionVisitor (lines 220-276)
- Uses existing `ParameterInfo` type from `types.ts`

---

### STEP 2: Refactor FunctionVisitor to Use Shared Utility

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`

#### Change 2.1: Add Import

**Location:** After existing imports (around line 24)

**Add:**
```typescript
import { createParameterNodes } from '../utils/createParameterNodes.js';
```

#### Change 2.2: Remove Local ParameterInfo Interface

**Location:** Lines 29-39

**REMOVE THESE LINES:**
```typescript
/**
 * Parameter node info
 */
interface ParameterInfo {
  id: string;
  type: 'PARAMETER';
  name: string;
  file: string;
  line: number;
  index: number;
  hasDefault?: boolean;
  isRest?: boolean;
  parentFunctionId: string;
}
```

**Reason:** Now using `ParameterInfo` from `types.ts` (it's already imported via the types file)

#### Change 2.3: Remove Local createParameterNodes Function

**Location:** Lines 220-276

**REMOVE THESE LINES:**
```typescript
    // Helper function to create PARAMETER nodes for function params
    const createParameterNodes = (
      params: Node[],
      functionId: string,
      file: string,
      line: number
    ): void => {
      if (!parameters) return; // Guard for backward compatibility

      params.forEach((param, index) => {
        // Handle different parameter types
        if (param.type === 'Identifier') {
          const paramId = `PARAMETER#${param.name}#${file}#${line}:${index}`;
          (parameters as ParameterInfo[]).push({
            id: paramId,
            type: 'PARAMETER',
            name: param.name,
            file: file,
            line: param.loc?.start.line || line,
            index: index,
            parentFunctionId: functionId
          });
        } else if (param.type === 'AssignmentPattern') {
          // Default parameter: function(a = 1)
          const assignmentParam = param as AssignmentPattern;
          if (assignmentParam.left.type === 'Identifier') {
            const paramId = `PARAMETER#${assignmentParam.left.name}#${file}#${line}:${index}`;
            (parameters as ParameterInfo[]).push({
              id: paramId,
              type: 'PARAMETER',
              name: assignmentParam.left.name,
              file: file,
              line: assignmentParam.left.loc?.start.line || line,
              index: index,
              hasDefault: true,
              parentFunctionId: functionId
            });
          }
        } else if ((param as Node).type === 'RestElement') {
          // Rest parameter: function(...args)
          const restParam = param as unknown as RestElement;
          if (restParam.argument.type === 'Identifier') {
            const paramId = `PARAMETER#${restParam.argument.name}#${file}#${line}:${index}`;
            (parameters as ParameterInfo[]).push({
              id: paramId,
              type: 'PARAMETER',
              name: restParam.argument.name,
              file: file,
              line: restParam.argument.loc?.start.line || line,
              index: index,
              isRest: true,
              parentFunctionId: functionId
            });
          }
        }
        // ObjectPattern and ArrayPattern (destructuring parameters) can be added later
      });
    };
```

**Reason:** This logic is now in the shared utility.

#### Change 2.4: Update createParameterNodes Calls

**Location 1:** Line 312 (in FunctionDeclaration handler)

**BEFORE:**
```typescript
        // Create PARAMETER nodes for function parameters
        createParameterNodes(node.params, functionId, module.file, node.loc!.start.line);
```

**AFTER:**
```typescript
        // Create PARAMETER nodes for function parameters
        createParameterNodes(node.params, functionId, module.file, node.loc!.start.line, parameters as ParameterInfo[]);
```

**Location 2:** Line 390 (in ArrowFunctionExpression handler)

**BEFORE:**
```typescript
        // Create PARAMETER nodes for arrow function parameters
        createParameterNodes(node.params, functionId, module.file, line);
```

**AFTER:**
```typescript
        // Create PARAMETER nodes for arrow function parameters
        createParameterNodes(node.params, functionId, module.file, line, parameters as ParameterInfo[]);
```

**Why cast to ParameterInfo[]:** The `parameters` variable is typed as `unknown[]` for backward compatibility in collections, but we know it's `ParameterInfo[]` at this point.

---

### STEP 3: Implement Parameter Creation in ClassVisitor

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

#### Change 3.1: Add Imports

**Location:** After existing imports (around line 27)

**ADD:**
```typescript
import { createParameterNodes } from '../utils/createParameterNodes.js';
import type { ParameterInfo } from '../types.js';
```

#### Change 3.2: Extract parameters from collections

**Location:** In `getHandlers()` method, around line 145-151

**BEFORE:**
```typescript
  getHandlers(): VisitorHandlers {
    const { module } = this;
    const {
      functions,
      scopes,
      classDeclarations,
      decorators
    } = this.collections;
```

**AFTER:**
```typescript
  getHandlers(): VisitorHandlers {
    const { module } = this;
    const {
      functions,
      scopes,
      classDeclarations,
      decorators,
      parameters
    } = this.collections;
```

#### Change 3.3: Add Parameter Creation for ClassProperty Functions

**Location:** In ClassProperty handler, after line 286 (after scopeTracker.enterScope)

**Current code around line 286:**
```typescript
              // Enter method scope for tracking
              scopeTracker.enterScope(propName, 'FUNCTION');

              // Create SCOPE for property function body
              const propBodyScopeId = `SCOPE#${className}.${propName}:body#${module.file}#${propNode.loc!.start.line}`;
```

**INSERT AFTER `scopeTracker.enterScope(propName, 'FUNCTION');`:**
```typescript
              // Create PARAMETER nodes for property function parameters
              if (parameters) {
                createParameterNodes(funcNode.params, functionId, module.file, propNode.loc!.start.line, parameters as ParameterInfo[]);
              }
```

**Result:**
```typescript
              // Enter method scope for tracking
              scopeTracker.enterScope(propName, 'FUNCTION');

              // Create PARAMETER nodes for property function parameters
              if (parameters) {
                createParameterNodes(funcNode.params, functionId, module.file, propNode.loc!.start.line, parameters as ParameterInfo[]);
              }

              // Create SCOPE for property function body
              const propBodyScopeId = `SCOPE#${className}.${propName}:body#${module.file}#${propNode.loc!.start.line}`;
```

#### Change 3.4: Add Parameter Creation for ClassMethod

**Location:** In ClassMethod handler, after line 342 (after scopeTracker.enterScope)

**Current code around line 342:**
```typescript
            // Enter method scope for tracking
            scopeTracker.enterScope(methodName, 'FUNCTION');

            // Create SCOPE for method body
            const methodBodyScopeId = `SCOPE#${className}.${methodName}:body#${module.file}#${methodNode.loc!.start.line}`;
```

**INSERT AFTER `scopeTracker.enterScope(methodName, 'FUNCTION');`:**
```typescript
            // Create PARAMETER nodes for method parameters
            if (parameters) {
              createParameterNodes(methodNode.params, functionId, module.file, methodNode.loc!.start.line, parameters as ParameterInfo[]);
            }
```

**Result:**
```typescript
            // Enter method scope for tracking
            scopeTracker.enterScope(methodName, 'FUNCTION');

            // Create PARAMETER nodes for method parameters
            if (parameters) {
              createParameterNodes(methodNode.params, functionId, module.file, methodNode.loc!.start.line, parameters as ParameterInfo[]);
            }

            // Create SCOPE for method body
            const methodBodyScopeId = `SCOPE#${className}.${methodName}:body#${module.file}#${methodNode.loc!.start.line}`;
```

**Critical timing note:** The `createParameterNodes` calls MUST come AFTER `scopeTracker.enterScope()` to ensure parameters are created in the correct scope context. This is already the natural flow in ClassVisitor.

---

### STEP 4: Create Test Fixture for Class Parameters

**File:** `/Users/vadimr/grafema/test/fixtures/parameters/class-params.js` (NEW)

**Full file contents:**

```javascript
// Test fixtures for class parameter PARAMETER node detection

// Class with constructor parameters
class ConfigService {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
  }

  // Method with regular and rest parameters
  process(data, ...extras) {
    return data;
  }

  // Arrow function property with parameter
  handler = (event) => {
    console.log(event);
  }

  // Async method with parameter
  async fetch(url) {
    return fetch(url);
  }

  // Getter (no parameters, should be ignored)
  get name() {
    return 'ConfigService';
  }

  // Setter (should have parameter)
  set timeout(value) {
    this._timeout = value;
  }
}

export { ConfigService };
```

**Why this fixture:**
- Tests constructor parameters (config, options with default)
- Tests method parameters (data, rest parameters)
- Tests arrow function property parameters (event)
- Tests async method parameters (url)
- Tests setter parameters (value)
- Provides comprehensive coverage for all class parameter scenarios

---

### STEP 5: Add Tests to Parameter.test.js

**File:** `/Users/vadimr/grafema/test/unit/Parameter.test.js`

**Location:** At the end of the file, after the existing `describe('Function parameters')` block (after line 181)

**ADD:**

```typescript
  describe('Class parameters', () => {
    const CLASS_FIXTURE_PATH = join(process.cwd(), 'test/fixtures/parameters/class-params.js');

    it('should create PARAMETER nodes for constructor parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find constructor parameters: config, options
      const configParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "config").
      `);

      const optionsParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "options").
      `);

      assert.ok(configParam.length >= 1, 'Should have "config" parameter from constructor');
      assert.ok(optionsParam.length >= 1, 'Should have "options" parameter from constructor');

      // Check that options has hasDefault: true
      if (optionsParam.length > 0) {
        const nodeId = optionsParam[0].bindings.find(b => b.name === 'X')?.value;
        if (nodeId) {
          const node = await backend.getNode(nodeId);
          assert.strictEqual(node?.hasDefault, true, 'options parameter should have hasDefault: true');
        }
      }
    });

    it('should create PARAMETER nodes for class method parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find method parameters: data, extras (rest)
      const dataParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "data").
      `);

      const extrasParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "extras").
      `);

      assert.ok(dataParam.length >= 1, 'Should have "data" parameter from process method');
      assert.ok(extrasParam.length >= 1, 'Should have "extras" rest parameter from process method');

      // Check that extras has isRest: true
      if (extrasParam.length > 0) {
        const nodeId = extrasParam[0].bindings.find(b => b.name === 'X')?.value;
        if (nodeId) {
          const node = await backend.getNode(nodeId);
          assert.strictEqual(node?.isRest, true, 'extras parameter should have isRest: true');
        }
      }
    });

    it('should create PARAMETER nodes for arrow function property parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find arrow function property parameter: event
      const eventParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "event").
      `);

      assert.ok(eventParam.length >= 1, 'Should have "event" parameter from handler arrow function property');
    });

    it('should create PARAMETER nodes for setter parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find setter parameter: value
      const valueParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "value").
      `);

      assert.ok(valueParam.length >= 1, 'Should have "value" parameter from setter');
    });

    it('should link class method PARAMETER nodes to parent FUNCTION via HAS_PARAMETER edges', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find process method
      const processMethod = await backend.checkGuarantee(`
        violation(X) :- node(X, "FUNCTION"), attr(X, "name", "process").
      `);

      assert.ok(processMethod.length >= 1, 'Should have process method');

      const funcId = processMethod[0].bindings.find(b => b.name === 'X')?.value;

      // Check HAS_PARAMETER edges from process to its parameters
      const processParams = await backend.checkGuarantee(`
        violation(P) :- edge("${funcId}", P, "HAS_PARAMETER").
      `);

      assert.ok(processParams.length >= 2, `process method should have at least 2 parameters, got ${processParams.length}`);
    });

    it('should link constructor PARAMETER nodes to parent FUNCTION via HAS_PARAMETER edges', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find constructor
      const constructor = await backend.checkGuarantee(`
        violation(X) :- node(X, "FUNCTION"), attr(X, "name", "constructor").
      `);

      assert.ok(constructor.length >= 1, 'Should have constructor');

      const funcId = constructor[0].bindings.find(b => b.name === 'X')?.value;

      // Check HAS_PARAMETER edges from constructor to its parameters
      const constructorParams = await backend.checkGuarantee(`
        violation(P) :- edge("${funcId}", P, "HAS_PARAMETER").
      `);

      assert.ok(constructorParams.length >= 2, `constructor should have at least 2 parameters, got ${constructorParams.length}`);
    });
  });
```

**Why these tests:**
- Covers constructor parameters (with default values)
- Covers method parameters (with rest parameters)
- Covers arrow function property parameters
- Covers setter parameters
- Verifies HAS_PARAMETER edges are created
- Matches the testing pattern from existing "Function parameters" tests

---

### STEP 6: Unskip Tests in ObjectMutationTracking.test.js

**File:** `/Users/vadimr/grafema/test/unit/ObjectMutationTracking.test.js`

#### Change 6.1: Unskip Constructor Test

**Location:** Line 247

**BEFORE:**
```typescript
    it.skip('should track this.prop = value in constructor with objectName "this"', async () => {
```

**AFTER:**
```typescript
    it('should track this.prop = value in constructor with objectName "this"', async () => {
```

**Remove or update comment:** Lines 248-249

**BEFORE:**
```typescript
      // SKIPPED: Class constructor parameters are not created as PARAMETER nodes.
      // See limitation note above. Create a Linear issue to track this.
```

**AFTER:**
```typescript
      // Now that class constructor parameters are created as PARAMETER nodes,
      // we can track data flow from parameters to this.prop assignments.
```

#### Change 6.2: Unskip Class Method Test

**Location:** Line 287

**BEFORE:**
```typescript
    it.skip('should track this.prop = value in class methods', async () => {
```

**AFTER:**
```typescript
    it('should track this.prop = value in class methods', async () => {
```

**Remove or update comment:** Lines 288-289

**BEFORE:**
```typescript
      // SKIPPED: Class method parameters are not created as PARAMETER nodes.
      // See limitation note above. Create a Linear issue to track this.
```

**AFTER:**
```typescript
      // Now that class method parameters are created as PARAMETER nodes,
      // we can track data flow from parameters to this.prop assignments.
```

#### Change 6.3: Update Section Comment

**Location:** Lines 240-245

**BEFORE:**
```typescript
  // ============================================================================
  // this.prop = value (in class methods/constructors)
  // LIMITATION: Class constructor/method parameters are not created as PARAMETER nodes
  // in the current implementation. This is a pre-existing architectural limitation
  // (not introduced by REG-114) that should be addressed in a separate issue.
  // These tests document the expected behavior once that limitation is fixed.
  // ============================================================================
```

**AFTER:**
```typescript
  // ============================================================================
  // this.prop = value (in class methods/constructors)
  // Now supported: Class constructor/method parameters are created as PARAMETER nodes
  // (implemented in REG-134). These tests verify data flow tracking from parameters
  // to object property mutations in class methods and constructors.
  // ============================================================================
```

---

## Implementation Order

Execute changes in this order to maintain working state at each step:

1. **Create utility** (Step 1) - No dependencies, safe to create first
2. **Refactor FunctionVisitor** (Step 2) - Uses new utility, existing tests verify correctness
3. **Run existing tests** - Verify refactoring didn't break anything
4. **Update ClassVisitor** (Step 3) - Add new feature
5. **Create test fixture** (Step 4) - Needed for new tests
6. **Add new tests** (Step 5) - Verify new feature works
7. **Unskip tests** (Step 6) - Verify integration with ObjectMutationTracking

---

## Test Execution Plan

### After Step 2 (FunctionVisitor refactor):
```bash
node --test test/unit/Parameter.test.js
```
**Expected:** All existing tests pass (we only refactored, behavior unchanged)

### After Step 5 (ClassVisitor implementation + new tests):
```bash
node --test test/unit/Parameter.test.js
```
**Expected:** All tests pass, including new class parameter tests

### After Step 6 (Unskip ObjectMutationTracking tests):
```bash
node --test test/unit/ObjectMutationTracking.test.js
```
**Expected:** Previously skipped tests now pass

### Full test suite:
```bash
npm test
```
**Expected:** All tests pass

---

## Potential Issues and Solutions

### Issue 1: Parameters Array Undefined
**Symptom:** `TypeError: Cannot read property 'push' of undefined`
**Cause:** `collections.parameters` not initialized
**Solution:** The guard `if (!parameters) return;` in `createParameterNodes` handles this gracefully

### Issue 2: Wrong parentFunctionId
**Symptom:** HAS_PARAMETER edges don't connect correctly
**Cause:** `functionId` variable not in scope when calling `createParameterNodes`
**Solution:** Both ClassProperty and ClassMethod handlers already compute `functionId` before the insertion point (lines 248 and 308 respectively)

### Issue 3: Scope Context Wrong
**Symptom:** Parameters created with wrong semantic IDs
**Cause:** `createParameterNodes` called before `scopeTracker.enterScope()`
**Solution:** All insertion points are AFTER `scopeTracker.enterScope()` calls

### Issue 4: Tests Fail After Unskipping
**Symptom:** ObjectMutationTracking tests fail when unskipped
**Cause:** Parameters not actually being created
**Debug:** Check GraphBuilder to ensure HAS_PARAMETER edges are created from ParameterInfo
**Solution:** GraphBuilder already handles this (line search for `parameters.forEach` or `HAS_PARAMETER`)

---

## Validation Checklist

After implementation, verify:

- [ ] FunctionVisitor still creates PARAMETER nodes (existing tests pass)
- [ ] ClassVisitor creates PARAMETER nodes for constructors
- [ ] ClassVisitor creates PARAMETER nodes for methods
- [ ] ClassVisitor creates PARAMETER nodes for arrow function properties
- [ ] ClassVisitor creates PARAMETER nodes for setters
- [ ] Default parameters have `hasDefault: true`
- [ ] Rest parameters have `isRest: true`
- [ ] HAS_PARAMETER edges connect FUNCTION to PARAMETER nodes
- [ ] ObjectMutationTracking tests pass (this.prop = value tracking works)
- [ ] No regressions in existing tests
- [ ] `npm test` passes fully

---

## Files Summary

| File | Status | Lines Changed | Type |
|------|--------|---------------|------|
| `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts` | NEW | ~90 | Utility |
| `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` | MODIFIED | -68, +3 | Refactor |
| `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` | MODIFIED | +17 | Feature |
| `/Users/vadimr/grafema/test/fixtures/parameters/class-params.js` | NEW | ~40 | Test Fixture |
| `/Users/vadimr/grafema/test/unit/Parameter.test.js` | MODIFIED | +120 | Tests |
| `/Users/vadimr/grafema/test/unit/ObjectMutationTracking.test.js` | MODIFIED | ~10 (comment changes, unskip) | Tests |

**Total:** 6 files, ~200 lines added, ~68 lines removed

---

## Architecture Notes

### Why Extract to Shared Utility?

1. **DRY Principle** - Same logic for parameters regardless of function context
2. **Future-Proof** - ObjectMethod, ExportedFunction, etc. can reuse
3. **Type Safety** - Single source of truth for ParameterInfo structure
4. **Testability** - Pure function, easy to test independently
5. **Maintainability** - Bug fixes or enhancements only need one change

### Why Not Use IdGenerator for Parameters?

Looking at `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/IdGenerator.ts`:
- Line 143-159: `generateLegacy()` method exists
- Comment says: "Used for: LITERAL (arguments), PARAMETER, DECORATOR, PROPERTY"
- However, FunctionVisitor (lines 220-276) doesn't use IdGenerator for parameters
- **Decision:** Match existing pattern in FunctionVisitor for consistency
- **Future:** Can enhance both FunctionVisitor and ClassVisitor to use IdGenerator in a separate refactoring

### Why Legacy IDs for Parameters?

- Parameters use legacy format: `PARAMETER#name#file#line:index`
- No semantic ID generation (no `scopeTracker.getContext()` call)
- **Reason:** Existing pattern in FunctionVisitor
- **Tradeoff:** Semantic IDs would be better for stability, but consistency with existing code is more important
- **Future:** Can add semantic IDs to parameters in both visitors simultaneously

---

## Next Steps After Implementation

1. **Manual Testing:** Run analysis on a real codebase with classes, verify PARAMETER nodes appear
2. **Performance Check:** Ensure no significant slowdown (unlikely, same logic as FunctionVisitor)
3. **Documentation:** Update any docs that mention the limitation (if any)
4. **Linear Issue:** Mark REG-134 as complete
5. **Tech Debt Backlog:** Consider adding semantic IDs for parameters (separate task)

---

## Questions for Review

1. **Should we use IdGenerator for parameters?** (Consistency vs. Future-proofing)
2. **Should we add semantic IDs now?** (More work, but future-proof)
3. **Should we handle destructuring parameters?** (Out of scope for this task, but easy to add)

**Recommendation:** Defer all three to separate tasks. Keep this change minimal and focused.
