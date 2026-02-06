# Joel Spolsky - Technical Specification for REG-311

## Summary

This specification expands Don Melton's high-level plan into a detailed implementation guide for tracking async error patterns (`Promise.reject()` and `reject()` callbacks). The implementation leverages existing REG-334 infrastructure for reject() detection in Promise executors and extends it with:

1. `Promise.reject(error)` static method detection
2. `canReject` metadata on ControlFlowMetadata
3. REJECTS edge type from function to error class

---

## Step 1: Add REJECTS Edge Type to Type Definitions

**File:** `packages/types/src/edges.ts`

**Changes:**
- After `THROWS: 'THROWS',` add new REJECTS edge type

```typescript
// Errors
THROWS: 'THROWS',
REJECTS: 'REJECTS',  // NEW: Async rejection edge (Promise.reject, reject callback)
```

**Complexity:** O(1) - constant time addition to enum

---

## Step 2: Register REJECTS in Known Edge Types

**File:** `packages/core/src/storage/backends/typeValidation.ts`

**Changes:**
- Add 'REJECTS' to the KNOWN_EDGE_TYPES Set after 'THROWS'

```typescript
'RETURNS', 'RECEIVES_ARGUMENT', 'READS_FROM', 'THROWS', 'REJECTS', 'REGISTERS_VIEW',
```

**Complexity:** O(1) - constant time Set addition

---

## Step 3: Extend ControlFlowMetadata with canReject

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

**Changes:**
- Add `canReject` field to ControlFlowMetadata interface

```typescript
export interface ControlFlowMetadata {
  hasBranches: boolean;      // Has if/switch statements
  hasLoops: boolean;         // Has any loop type
  hasTryCatch: boolean;      // Has try/catch blocks
  hasEarlyReturn: boolean;   // Has return before function end
  hasThrow: boolean;         // Has throw statements
  canReject: boolean;        // NEW: Has async rejection patterns (Promise.reject, reject())
  cyclomaticComplexity: number;
}
```

**Add new type after PromiseResolutionInfo:**

```typescript
// === REJECTION PATTERN INFO ===
/**
 * Info for async rejection REJECTS edges.
 * Created when Promise.reject(new Error()) or reject(new Error()) is detected.
 *
 * Graph structure:
 * FUNCTION --REJECTS--> CLASS (for error class)
 *
 * Edge direction: containing FUNCTION -> error CLASS
 * This allows queries like "what errors can this function reject?"
 */
export interface RejectionPatternInfo {
  /** ID of the containing FUNCTION node */
  functionId: string;
  /** Error class name (e.g., 'Error', 'ValidationError') */
  errorClassName: string;
  /** Rejection pattern type */
  rejectionType: 'promise_reject' | 'executor_reject';
  /** File path */
  file: string;
  /** Line number of rejection call */
  line: number;
  /** Column number */
  column: number;
}
```

**Update ASTCollections interface:**

```typescript
// Promise resolution tracking for RESOLVES_TO edges (REG-334)
promiseResolutions?: PromiseResolutionInfo[];
// Rejection pattern tracking for REJECTS edges (REG-311)
rejectionPatterns?: RejectionPatternInfo[];
// Promise executor contexts (REG-334) - keyed by executor function's start:end position
promiseExecutorContexts?: Map<string, PromiseExecutorContext>;
```

**Complexity:** O(1) - type definition only

---

## Step 4: Initialize canReject in controlFlowState

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Changes:**

**4a. Add canReject to controlFlowState initialization**

```typescript
const controlFlowState = {
  branchCount: 0,
  loopCount: 0,
  caseCount: 0,
  logicalOpCount: 0,
  hasTryCatch: false,
  hasEarlyReturn: false,
  hasThrow: false,
  canReject: false,       // NEW: Track async rejection patterns
  returnCount: 0,
  totalStatements: 0
};
```

**4b. Add canReject to controlFlow metadata assignment**

```typescript
matchingFunction.controlFlow = {
  hasBranches: controlFlowState.branchCount > 0,
  hasLoops: controlFlowState.loopCount > 0,
  hasTryCatch: controlFlowState.hasTryCatch,
  hasEarlyReturn: controlFlowState.hasEarlyReturn,
  hasThrow: controlFlowState.hasThrow,
  canReject: controlFlowState.canReject,  // NEW
  cyclomaticComplexity
};
```

**Complexity:** O(1) - constant time state initialization

---

## Step 5: Detect Promise.reject() Static Method Calls

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Changes:**

**5a. Add new import for RejectionPatternInfo:**

```typescript
PromiseResolutionInfo,
RejectionPatternInfo,  // NEW
PromiseExecutorContext,
```

**5b. Initialize rejectionPatterns collection:**

```typescript
// Promise resolution tracking for RESOLVES_TO edges (REG-334)
const promiseResolutions: PromiseResolutionInfo[] = [];
// Rejection pattern tracking for REJECTS edges (REG-311)
const rejectionPatterns: RejectionPatternInfo[] = [];
// Promise executor contexts (REG-334)
const promiseExecutorContexts = new Map<string, PromiseExecutorContext>();
```

**5c. Extend handleCallExpression method for Promise.reject detection:**

```typescript
// Check for Promise.reject() static method (REG-311)
if (objectName === 'Promise' && methodName === 'reject') {
  // Initialize collection if not exists
  if (!collections.rejectionPatterns) {
    collections.rejectionPatterns = [];
  }

  // Extract error class from first argument
  if (callNode.arguments.length > 0) {
    const arg = callNode.arguments[0];
    // Only track new ErrorClass() patterns
    if (t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
      const errorClassName = arg.callee.name;
      const containingFunction = this.findContainingFunction(callNode, functions);

      if (containingFunction) {
        (collections.rejectionPatterns as RejectionPatternInfo[]).push({
          functionId: containingFunction.id,
          errorClassName,
          rejectionType: 'promise_reject',
          file: module.file,
          line: getLine(callNode),
          column: getColumn(callNode)
        });
      }
    }
  }
}
```

**5d. Add Promise.reject detection in analyzeFunctionBody:**

In the CallExpression visitor within analyzeFunctionBody, add:

```typescript
// REG-311: Detect Promise.reject() and set canReject
if (t.isMemberExpression(callNode.callee) &&
    t.isIdentifier(callNode.callee.object) &&
    callNode.callee.object.name === 'Promise' &&
    t.isIdentifier(callNode.callee.property) &&
    callNode.callee.property.name === 'reject') {
  controlFlowState.canReject = true;
}
```

**Complexity:** O(1) per call expression - pattern matching

---

## Step 6: Set canReject for executor reject() Calls

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Changes:**

Extend the existing reject() detection to set canReject:

```typescript
if (context) {
  const isResolve = calleeName === context.resolveName;
  const isReject = calleeName === context.rejectName;

  if (isResolve || isReject) {
    // REG-311: Set canReject when reject is called
    if (isReject) {
      controlFlowState.canReject = true;
    }

    // ... existing promiseResolutions.push code ...

    // REG-311: Extract error class for REJECTS edge
    if (isReject && callNode.arguments.length > 0) {
      const arg = callNode.arguments[0];
      if (t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
        const errorClassName = arg.callee.name;
        const containingFunction = functions.find(f =>
          f.file === module.file && f.line <= callLine
        );

        if (containingFunction && collections.rejectionPatterns) {
          (collections.rejectionPatterns as RejectionPatternInfo[]).push({
            functionId: containingFunction.id,
            errorClassName,
            rejectionType: 'executor_reject',
            file: module.file,
            line: callLine,
            column: callColumn
          });
        }
      }
    }
  }
}
```

**Complexity:** O(d) where d = function nesting depth (same as existing REG-334 pattern)

---

## Step 7: Add bufferRejectionEdges to GraphBuilder

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Changes:**

**7a. Import RejectionPatternInfo:**

```typescript
PromiseResolutionInfo,
RejectionPatternInfo,  // NEW
ASTCollections,
```

**7b. Destructure rejectionPatterns in build() method:**

```typescript
// Promise resolution tracking for RESOLVES_TO edges (REG-334)
promiseResolutions = [],
// Rejection pattern tracking for REJECTS edges (REG-311)
rejectionPatterns = [],
```

**7c. Call bufferRejectionEdges after bufferPromiseResolutionEdges:**

```typescript
// 31. Buffer RESOLVES_TO edges for Promise data flow (REG-334)
this.bufferPromiseResolutionEdges(promiseResolutions);

// 32. Buffer REJECTS edges for async error tracking (REG-311)
this.bufferRejectionEdges(rejectionPatterns, classDeclarations);
```

**7d. Add bufferRejectionEdges method:**

```typescript
/**
 * Buffer REJECTS edges for async error pattern tracking (REG-311).
 *
 * Links FUNCTION nodes to error CLASS nodes they can reject.
 * This enables queries like "what errors can this function reject?"
 *
 * Example:
 * ```
 * function fail() {
 *   return Promise.reject(new ValidationError('fail'));
 * }
 * // Creates: FUNCTION[fail] --REJECTS--> CLASS[ValidationError]
 * ```
 *
 * Only creates edges when:
 * 1. Error is created inline: reject(new Error()) or Promise.reject(new Error())
 * 2. Target error class exists in classDeclarations
 *
 * Limitation: Does not track reject(err) where err is a variable.
 */
private bufferRejectionEdges(
  rejectionPatterns: RejectionPatternInfo[],
  classDeclarations: ClassDeclarationInfo[]
): void {
  for (const pattern of rejectionPatterns) {
    // Find the error class node
    const errorClass = classDeclarations.find(c => c.name === pattern.errorClassName);

    if (errorClass) {
      // Create REJECTS edge from function to error class
      this._bufferEdge({
        type: 'REJECTS',
        src: pattern.functionId,
        dst: errorClass.id,
        metadata: {
          rejectionType: pattern.rejectionType,
          line: pattern.line
        }
      });
    } else {
      // Error class not found in codebase (likely built-in like Error, TypeError)
      // Create edge to a synthetic CLASS node ID
      const syntheticClassId = `CLASS:${pattern.errorClassName}:builtin`;
      this._bufferEdge({
        type: 'REJECTS',
        src: pattern.functionId,
        dst: syntheticClassId,
        metadata: {
          rejectionType: pattern.rejectionType,
          line: pattern.line,
          isBuiltin: true
        }
      });
    }
  }
}
```

**Complexity:** O(r * c) where r = rejection patterns, c = class declarations. In practice O(r) since class lookup can be optimized to Map.

---

## Step 8: Include rejectionPatterns in Collections Return

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Changes:**

Ensure rejectionPatterns is included in the collections object returned by collectAST:

```typescript
return {
  // ... existing collections ...
  promiseResolutions,
  rejectionPatterns,  // NEW
  promiseExecutorContexts,
  // ...
};
```

**Complexity:** O(1) - object property assignment

---

## Test Plan

### Test File 1: Function Metadata Tests

**File:** `test/unit/plugins/analysis/ast/function-metadata.test.ts`

Add new test group after existing tests:

```typescript
// ===========================================================================
// GROUP: canReject detection (REG-311)
// ===========================================================================

describe('canReject detection (REG-311)', () => {
  it('should detect canReject = true for Promise.reject()', async () => {
    await setupTest(backend, {
      'index.js': `
function fail() {
  return Promise.reject(new Error('failed'));
}
      `
    });

    const funcNode = await getFunctionByName(backend, 'fail');
    assert.ok(funcNode, 'Should have FUNCTION node named "fail"');

    const controlFlow = getControlFlowMetadata(funcNode);
    assert.ok(controlFlow, 'Should have controlFlow metadata');
    assert.strictEqual(controlFlow.canReject, true, 'canReject should be true');
  });

  it('should detect canReject = true for reject() in executor', async () => {
    await setupTest(backend, {
      'index.js': `
function asyncOp() {
  return new Promise((resolve, reject) => {
    if (bad) reject(new Error('bad'));
  });
}
      `
    });

    const funcNode = await getFunctionByName(backend, 'asyncOp');
    const controlFlow = getControlFlowMetadata(funcNode);
    assert.ok(controlFlow, 'Should have controlFlow metadata');
    assert.strictEqual(controlFlow.canReject, true, 'canReject should be true');
  });

  it('should have canReject = false for function without rejections', async () => {
    await setupTest(backend, {
      'index.js': `
function success() {
  return Promise.resolve(42);
}
      `
    });

    const funcNode = await getFunctionByName(backend, 'success');
    const controlFlow = getControlFlowMetadata(funcNode);
    assert.ok(controlFlow, 'Should have controlFlow metadata');
    assert.strictEqual(controlFlow.canReject, false, 'canReject should be false');
  });
});
```

### Test File 2: Rejection Patterns Tests (NEW)

**File:** `test/unit/analysis/rejection-patterns.test.ts`

```typescript
/**
 * Tests for Async Error Pattern Tracking (REG-311)
 *
 * Tests REJECTS edge creation for:
 * - Promise.reject(new Error())
 * - reject(new Error()) inside Promise executor
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
// ... standard test setup imports ...

describe('REJECTS Edge Creation (REG-311)', () => {
  // Test 1: Promise.reject with custom error class
  it('should create REJECTS edge from function to custom error class', async () => {
    await setupTest(backend, {
      'index.js': `
class ValidationError extends Error {}

function validate() {
  return Promise.reject(new ValidationError('invalid'));
}
      `
    });

    const rejectsEdges = await findEdgesByType(backend, 'REJECTS');
    assert.ok(rejectsEdges.length >= 1, 'Should have REJECTS edge');

    const funcNode = await getFunctionByName(backend, 'validate');
    const edge = rejectsEdges.find(e => e.src === funcNode!.id);
    assert.ok(edge, 'REJECTS edge should originate from validate function');
  });

  // Test 2: reject() in Promise executor
  it('should create REJECTS edge for reject() in executor', async () => {
    await setupTest(backend, {
      'index.js': `
class DbError extends Error {}

function query() {
  return new Promise((resolve, reject) => {
    if (bad) reject(new DbError('query failed'));
  });
}
      `
    });

    const rejectsEdges = await findEdgesByType(backend, 'REJECTS');
    assert.ok(rejectsEdges.length >= 1, 'Should have REJECTS edge');
  });

  // Test 3: Multiple rejection types
  it('should create multiple REJECTS edges for different error types', async () => {
    await setupTest(backend, {
      'index.js': `
class TypeError extends Error {}
class RangeError extends Error {}

function complex() {
  return new Promise((resolve, reject) => {
    if (a) reject(new TypeError());
    if (b) reject(new RangeError());
  });
}
      `
    });

    const rejectsEdges = await findEdgesByType(backend, 'REJECTS');
    assert.ok(rejectsEdges.length >= 2, 'Should have 2 REJECTS edges');
  });

  // Test 4: Built-in Error class
  it('should handle built-in Error class rejection', async () => {
    await setupTest(backend, {
      'index.js': `
function fail() {
  return Promise.reject(new Error('generic error'));
}
      `
    });

    const rejectsEdges = await findEdgesByType(backend, 'REJECTS');
    assert.ok(rejectsEdges.length >= 1, 'Should have REJECTS edge for built-in Error');
  });

  // Test 5: No REJECTS edge for variable rejection
  it('should NOT create REJECTS edge for variable rejection (out of scope)', async () => {
    await setupTest(backend, {
      'index.js': `
function forward(err) {
  return Promise.reject(err);  // err is variable, not new Error()
}
      `
    });

    const rejectsEdges = await findEdgesByType(backend, 'REJECTS');
    assert.strictEqual(rejectsEdges.length, 0, 'Should NOT have REJECTS edge for variable');
  });
});
```

---

## Complexity Analysis Summary

| Step | Operation | Complexity |
|------|-----------|------------|
| 1-3  | Type definitions | O(1) |
| 4    | State initialization | O(1) |
| 5    | Promise.reject detection | O(1) per call |
| 6    | Executor reject detection | O(d) d=nesting |
| 7    | Edge buffering | O(r) r=patterns |
| **Total per file** | | O(n + r) n=calls |

**No new full-graph iterations** - all detection integrates into existing AST traversal.

---

## Implementation Order

1. **Step 1-2**: Add REJECTS edge type (prerequisite)
2. **Step 3**: Extend types (prerequisite)
3. **Step 4**: Initialize controlFlowState (foundational)
4. **Step 5-6**: Detection logic (core feature)
5. **Step 7-8**: Edge creation (output)
6. **Tests**: Write tests per TDD

Estimated effort: **3.5 days** (aligns with Don's estimate of 4 days total)
