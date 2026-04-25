# Joel Spolsky - Expanded Technical Specification for REG-311

## Summary of Changes from Original Spec

Based on Don Melton's semantic analysis (006-don-async-await-analysis.md) and the reviews from Steve Jobs and Vadim Reshevnikov, this expanded spec addresses three critical issues:

1. **Semantic Error in Async/Await Handling**: `throw` in async function should set `canReject=true`, NOT `hasThrow=true` (this is the fundamental fix from Don's analysis)
2. **Remove Synthetic Builtin CLASS Nodes**: Store builtin errors in metadata instead of creating phantom edges (Steve/Vadim requirement)
3. **Optimize Class Lookups**: Use Map for O(1) lookups instead of O(r*c) array.find() (Vadim's performance concern)

---

## Step 3 REVISED: Extend ControlFlowMetadata with Async-Aware Fields

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

**Lines:** 183-192

**Original:**
```typescript
export interface ControlFlowMetadata {
  hasBranches: boolean;      // Has if/switch statements
  hasLoops: boolean;         // Has any loop type
  hasTryCatch: boolean;      // Has try/catch blocks
  hasEarlyReturn: boolean;   // Has return before function end
  hasThrow: boolean;         // Has throw statements
  cyclomaticComplexity: number;  // McCabe cyclomatic complexity
}
```

**New:**
```typescript
export interface ControlFlowMetadata {
  hasBranches: boolean;           // Has if/switch statements
  hasLoops: boolean;              // Has any loop type
  hasTryCatch: boolean;           // Has try/catch blocks
  hasEarlyReturn: boolean;        // Has return before function end
  hasThrow: boolean;              // Sync throw in sync function ONLY
  canReject: boolean;             // NEW: Has async rejection patterns
  hasAsyncThrow?: boolean;        // NEW: throw in async function (= rejection)
  rejectedBuiltinErrors?: string[]; // NEW: Builtin errors ['Error', 'TypeError']
  cyclomaticComplexity: number;   // McCabe cyclomatic complexity
}
```

**Complexity:** O(1) - type definition only

---

## Step 3b NEW: Add RejectionPatternInfo with Async Throw Support

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

**Location:** After PromiseResolutionInfo (line 861)

**New:**
```typescript
// === REJECTION PATTERN INFO (REG-311) ===
/**
 * Info for async rejection REJECTS edges.
 * Created when Promise.reject(new Error()), reject(new Error()),
 * or throw new Error() in async function is detected.
 *
 * Graph structure:
 * FUNCTION --REJECTS--> CLASS (for user-defined error class)
 *
 * For builtin errors (Error, TypeError, etc.), no edge is created.
 * Instead, the error name is stored in ControlFlowMetadata.rejectedBuiltinErrors.
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
  rejectionType:
    | 'promise_reject'   // Promise.reject(new Error())
    | 'executor_reject'  // reject(new Error()) in Promise executor
    | 'async_throw';     // throw new Error() in async function
  /** File path */
  file: string;
  /** Line number of rejection call */
  line: number;
  /** Column number */
  column: number;
}
```

**Complexity:** O(1) - type definition only

---

## Step 3c NEW: Update ASTCollections Interface

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

**Location:** After promiseResolutions field (line 925-927)

**Original:**
```typescript
// Promise resolution tracking for RESOLVES_TO edges (REG-334)
promiseResolutions?: PromiseResolutionInfo[];
// Promise executor contexts (REG-334) - keyed by executor function's start:end position
promiseExecutorContexts?: Map<string, PromiseExecutorContext>;
```

**New:**
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

## Step 4 REVISED: Initialize controlFlowState with Async-Aware Fields

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Lines:** 3638-3649

**Original:**
```typescript
const controlFlowState = {
  branchCount: 0,       // if/switch statements
  loopCount: 0,         // for/while/do-while/for-in/for-of
  caseCount: 0,         // switch cases (excluding default)
  logicalOpCount: 0,    // && and || in conditions
  hasTryCatch: false,
  hasEarlyReturn: false,
  hasThrow: false,
  returnCount: 0,       // Track total return count for early return detection
  totalStatements: 0    // Track if there are statements after returns
};
```

**New:**
```typescript
const controlFlowState = {
  branchCount: 0,       // if/switch statements
  loopCount: 0,         // for/while/do-while/for-in/for-of
  caseCount: 0,         // switch cases (excluding default)
  logicalOpCount: 0,    // && and || in conditions
  hasTryCatch: false,
  hasEarlyReturn: false,
  hasThrow: false,
  canReject: false,           // NEW: Track async rejection patterns
  hasAsyncThrow: false,       // NEW: Track throw in async function
  rejectedBuiltinErrors: [] as string[],  // NEW: Track builtin error names
  returnCount: 0,       // Track total return count for early return detection
  totalStatements: 0    // Track if there are statements after returns
};
```

**Complexity:** O(1) - constant time state initialization

---

## Step 5 REVISED: Modify ThrowStatement Handler for Async Awareness

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Lines:** 3803-3816

**Original:**
```typescript
// Phase 6 (REG-267): Track throw statements for control flow metadata
ThrowStatement: (throwPath: NodePath<t.ThrowStatement>) => {
  // Skip if this throw is inside a nested function (not the function we're analyzing)
  let parent: NodePath | null = throwPath.parentPath;
  while (parent) {
    if (t.isFunction(parent.node) && parent.node !== funcNode) {
      // This throw is inside a nested function - skip it
      return;
    }
    parent = parent.parentPath;
  }

  controlFlowState.hasThrow = true;
},
```

**New:**
```typescript
// Phase 6 (REG-267) + REG-311: Track throw statements with async awareness
ThrowStatement: (throwPath: NodePath<t.ThrowStatement>) => {
  // Skip if this throw is inside a nested function (not the function we're analyzing)
  let parent: NodePath | null = throwPath.parentPath;
  while (parent) {
    if (t.isFunction(parent.node) && parent.node !== funcNode) {
      // This throw is inside a nested function - skip it
      return;
    }
    parent = parent.parentPath;
  }

  const throwNode = throwPath.node;

  // REG-311: Check if containing function is async
  // funcNode is the function we're analyzing (captured in analyzeFunctionBody closure)
  const isAsyncFunction =
    (t.isFunctionDeclaration(funcNode) || t.isFunctionExpression(funcNode)) && funcNode.async === true ||
    t.isArrowFunctionExpression(funcNode) && funcNode.async === true;

  if (isAsyncFunction) {
    // throw in async function = promise rejection, NOT sync throw
    controlFlowState.canReject = true;
    controlFlowState.hasAsyncThrow = true;
    // DON'T set hasThrow = true (semantic distinction)

    // REG-311: Extract error class for REJECTS edge
    if (throwNode.argument && t.isNewExpression(throwNode.argument)) {
      const newExpr = throwNode.argument;
      if (t.isIdentifier(newExpr.callee)) {
        const errorClassName = newExpr.callee.name;

        // Initialize rejectionPatterns if not exists
        if (!collections.rejectionPatterns) {
          collections.rejectionPatterns = [];
        }
        const rejectionPatterns = collections.rejectionPatterns as RejectionPatternInfo[];

        rejectionPatterns.push({
          functionId: currentFunctionId!,
          errorClassName,
          rejectionType: 'async_throw',
          file: module.file,
          line: getLine(throwNode),
          column: getColumn(throwNode)
        });
      }
    }
  } else {
    // Normal sync throw
    controlFlowState.hasThrow = true;
  }
},
```

**Key insight:** We access `funcNode` directly (already available in scope at line 3624) and check its `async` property. The AST node types `FunctionDeclaration`, `FunctionExpression`, and `ArrowFunctionExpression` all have the `async: boolean` property.

**Complexity:** O(1) per throw statement - pattern matching and property access

---

## Step 6 REVISED: Extend Promise.reject() Detection

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** In `handleCallExpression` method (around line 4376)

**Add after existing `Promise.resolve()` handling:**

```typescript
// REG-311: Check for Promise.reject() static method
if (objectName === 'Promise' && methodName === 'reject') {
  // Set canReject in controlFlowState (if in function context)
  if (controlFlowState) {
    controlFlowState.canReject = true;
  }

  // Extract error class from first argument
  if (callNode.arguments.length > 0) {
    const arg = callNode.arguments[0];
    // Only track new ErrorClass() patterns
    if (t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
      const errorClassName = arg.callee.name;

      // Initialize rejectionPatterns if not exists
      if (!collections.rejectionPatterns) {
        collections.rejectionPatterns = [];
      }
      const rejectionPatterns = collections.rejectionPatterns as RejectionPatternInfo[];

      // Find containing function
      const containingFunction = functions.find(f =>
        f.file === module.file && f.line <= getLine(callNode)
      );

      if (containingFunction) {
        rejectionPatterns.push({
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

**Complexity:** O(1) per call expression

---

## Step 6b REVISED: Extend Executor reject() Detection

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** In existing reject() detection block within `analyzeFunctionBody` (the code that handles REG-334 promise executor contexts)

**Original pattern (around line 3720-3750):**
```typescript
if (context) {
  const isResolve = calleeName === context.resolveName;
  const isReject = calleeName === context.rejectName;

  if (isResolve || isReject) {
    // ... existing promiseResolutions.push code ...
  }
}
```

**Extended with rejection pattern tracking:**
```typescript
if (context) {
  const isResolve = calleeName === context.resolveName;
  const isReject = calleeName === context.rejectName;

  if (isResolve || isReject) {
    // REG-311: Set canReject when reject is called
    if (isReject) {
      controlFlowState.canReject = true;

      // REG-311: Extract error class for REJECTS edge
      if (callNode.arguments.length > 0) {
        const arg = callNode.arguments[0];
        if (t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
          const errorClassName = arg.callee.name;

          // Initialize rejectionPatterns if not exists
          if (!collections.rejectionPatterns) {
            collections.rejectionPatterns = [];
          }
          const rejectionPatterns = collections.rejectionPatterns as RejectionPatternInfo[];

          rejectionPatterns.push({
            functionId: currentFunctionId!,
            errorClassName,
            rejectionType: 'executor_reject',
            file: module.file,
            line: getLine(callNode),
            column: getColumn(callNode)
          });
        }
      }
    }

    // ... existing promiseResolutions.push code ...
  }
}
```

**Complexity:** O(d) where d = function nesting depth (same as existing REG-334 pattern)

---

## Step 7 REVISED: Update Control Flow Metadata Assignment

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Lines:** 4321-4328

**Original:**
```typescript
matchingFunction.controlFlow = {
  hasBranches: controlFlowState.branchCount > 0,
  hasLoops: controlFlowState.loopCount > 0,
  hasTryCatch: controlFlowState.hasTryCatch,
  hasEarlyReturn: controlFlowState.hasEarlyReturn,
  hasThrow: controlFlowState.hasThrow,
  cyclomaticComplexity
};
```

**New:**
```typescript
matchingFunction.controlFlow = {
  hasBranches: controlFlowState.branchCount > 0,
  hasLoops: controlFlowState.loopCount > 0,
  hasTryCatch: controlFlowState.hasTryCatch,
  hasEarlyReturn: controlFlowState.hasEarlyReturn,
  hasThrow: controlFlowState.hasThrow,
  canReject: controlFlowState.canReject,  // NEW
  hasAsyncThrow: controlFlowState.hasAsyncThrow || undefined,  // NEW (omit if false)
  rejectedBuiltinErrors: controlFlowState.rejectedBuiltinErrors.length > 0
    ? controlFlowState.rejectedBuiltinErrors
    : undefined,  // NEW (omit if empty)
  cyclomaticComplexity
};
```

**Complexity:** O(1)

---

## Step 8 REVISED: Add bufferRejectionEdges WITHOUT Synthetic Nodes

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Original from Joel's plan (Step 7d) - REMOVED synthetic builtin handling:**

**New implementation (CRITICAL FIX from Steve/Vadim reviews):**

```typescript
/**
 * Buffer REJECTS edges for async error pattern tracking (REG-311).
 *
 * Links FUNCTION nodes to error CLASS nodes they can reject.
 * This enables queries like "what errors can this function reject?"
 *
 * IMPORTANT: Only creates edges for USER-DEFINED error classes.
 * Built-in errors (Error, TypeError, etc.) are stored in function metadata
 * (rejectedBuiltinErrors array) instead of creating phantom edges.
 *
 * Example:
 * ```javascript
 * async function fail() {
 *   throw new ValidationError('fail');  // Creates: FUNCTION[fail] --REJECTS--> CLASS[ValidationError]
 * }
 * ```
 *
 * Patterns tracked:
 * - Promise.reject(new ErrorClass())
 * - reject(new ErrorClass()) inside Promise executor
 * - throw new ErrorClass() inside async function
 *
 * Limitation (MVP): Does not track reject(err) where err is a variable.
 * This requires data flow analysis and is deferred to future enhancement.
 *
 * @param rejectionPatterns - Collection of rejection patterns detected during AST analysis
 * @param classDeclarations - Collection of class declarations for lookup
 * @param functions - Collection of function declarations for metadata update
 */
private bufferRejectionEdges(
  rejectionPatterns: RejectionPatternInfo[],
  classDeclarations: ClassDeclarationInfo[],
  functions: FunctionInfo[]
): void {
  // O(c) preprocessing: Build lookup Map for class declarations
  const classMap = new Map<string, ClassDeclarationInfo>();
  for (const classDecl of classDeclarations) {
    classMap.set(classDecl.name, classDecl);
  }

  // O(f) preprocessing: Build lookup Map for functions
  const functionMap = new Map<string, FunctionInfo>();
  for (const func of functions) {
    functionMap.set(func.id, func);
  }

  for (const pattern of rejectionPatterns) {
    const errorClass = classMap.get(pattern.errorClassName);  // O(1) lookup

    if (errorClass) {
      // User-defined error class - create REJECTS edge
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
      // Built-in error class (Error, TypeError, etc.) - NO phantom nodes!
      // Store in function metadata instead
      const func = functionMap.get(pattern.functionId);
      if (func && func.controlFlow) {
        // Initialize array if needed
        if (!func.controlFlow.rejectedBuiltinErrors) {
          func.controlFlow.rejectedBuiltinErrors = [];
        }
        // Add if not already present
        if (!func.controlFlow.rejectedBuiltinErrors.includes(pattern.errorClassName)) {
          func.controlFlow.rejectedBuiltinErrors.push(pattern.errorClassName);
        }
      }
    }
  }
}
```

**Complexity:** O(c + f + r) where c = classes, f = functions, r = rejection patterns. This is O(r) in practice since Map lookups are O(1).

**Critical difference from original plan:**
- NO synthetic `CLASS:Error:builtin` nodes created
- Builtin errors stored in `rejectedBuiltinErrors` metadata array
- Uses Map for O(1) lookups instead of array.find() O(n)

---

## Step 9 NEW: Call bufferRejectionEdges in GraphBuilder.build()

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location:** After line 373 (after bufferPromiseResolutionEdges)

**Add:**
```typescript
// 31. Buffer RESOLVES_TO edges for Promise data flow (REG-334)
this.bufferPromiseResolutionEdges(promiseResolutions);

// 32. Buffer REJECTS edges for async error tracking (REG-311)
this.bufferRejectionEdges(rejectionPatterns, classDeclarations, functions);
```

**Also add rejectionPatterns to destructuring at build() method signature (around line 128-142):**

```typescript
// Promise resolution tracking for RESOLVES_TO edges (REG-334)
promiseResolutions = [],
// Rejection pattern tracking for REJECTS edges (REG-311)
rejectionPatterns = [],
```

---

## Test Matrix Summary

| Pattern | hasThrow | canReject | hasAsyncThrow | REJECTS edge | Metadata |
|---------|----------|-----------|---------------|--------------|----------|
| `throw` in sync function | true | false | undefined | No | - |
| `throw` in async function | false | true | true | Yes (user-defined) | rejectedBuiltinErrors (builtin) |
| `Promise.reject(new Error())` | false | true | undefined | Yes (user-defined) | rejectedBuiltinErrors (builtin) |
| `reject(new Error())` in executor | false | true | undefined | Yes (user-defined) | rejectedBuiltinErrors (builtin) |
| `throw` in async, builtin Error | false | true | true | No | rejectedBuiltinErrors |
| `reject(err)` variable | - | - | - | No (MVP limitation) | - |

---

## Complexity Analysis Summary

| Step | Operation | Complexity |
|------|-----------|------------|
| 1-3 | Type definitions | O(1) |
| 4 | State initialization | O(1) |
| 5 | ThrowStatement async detection | O(1) per throw |
| 6 | Promise.reject detection | O(1) per call |
| 6b | Executor reject detection | O(d) d=nesting |
| 7 | Control flow metadata assignment | O(1) |
| 8 | bufferRejectionEdges with Map | O(c + f + r) |
| **Total per file** | | O(n + r) n=AST nodes |

**Critical improvement from original plan:** Step 8 now uses Map for O(1) lookups instead of O(r * c) array.find().

---

## Implementation Order

1. **Step 1-2** (from original): Add REJECTS edge type to edges.ts and typeValidation.ts
2. **Step 3 REVISED**: Extend ControlFlowMetadata with async-aware fields
3. **Step 3b NEW**: Add RejectionPatternInfo type with async_throw support
4. **Step 3c NEW**: Update ASTCollections interface
5. **Step 4 REVISED**: Initialize controlFlowState with new fields
6. **Step 5 REVISED**: Modify ThrowStatement handler for async awareness (CRITICAL)
7. **Step 6 REVISED**: Add Promise.reject() detection
8. **Step 6b REVISED**: Extend executor reject() detection
9. **Step 7 REVISED**: Update control flow metadata assignment
10. **Step 8 REVISED**: Add bufferRejectionEdges WITHOUT synthetic nodes (CRITICAL)
11. **Step 9 NEW**: Call bufferRejectionEdges in GraphBuilder.build()
12. **Tests**: Write and run all test cases

**Estimated effort:** 4.5 days (original 3.5 days + 1 day for async awareness fix)
