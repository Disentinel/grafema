# Don Melton - Async/Await Semantic Analysis for REG-311

## Executive Summary

Vadim's review correctly identified a **fundamental semantic error** in the original plan. The plan treats `throw` inside async functions as a synchronous throw (`hasThrow=true`) when it is actually a **promise rejection** (`canReject=true`). This is not just a metadata bug - it reflects a deeper misunderstanding of JavaScript async semantics that will make queries return incorrect results.

This analysis provides the semantic foundation needed to fix REG-311 properly.

---

## 1. Semantic Analysis: How Async/Await Changes Error Handling

### 1.1 The Fundamental Difference

According to MDN and ECMAScript specification research:

**Synchronous throw:**
```javascript
function syncFn() {
  throw new Error('fail');  // Immediately unwinds call stack
}
// Calling syncFn() throws - must be in try/catch
```

**Throw inside async function:**
```javascript
async function asyncFn() {
  throw new Error('fail');  // Does NOT throw! Returns rejected Promise
}
// Calling asyncFn() returns Promise.reject(Error('fail'))
// No exception occurs at call site
```

**Key insight from MDN async function documentation:**

> "Each time when an async function is called, it returns a new Promise which will be resolved with the value returned by the async function, or **rejected with an exception uncaught within the async function**."

This means `throw` in async functions is **semantically equivalent** to `return Promise.reject()`.

### 1.2 Execution Model

| Operation | Sync Function | Async Function |
|-----------|---------------|----------------|
| `throw new Error()` | Unwinds stack immediately | Returns rejected Promise |
| `return value` | Returns value immediately | Returns resolved Promise |
| Error propagation | Up the call stack | Through Promise chain |
| Caught by | `try/catch` at call site | `.catch()` or `await` in `try/catch` |

### 1.3 Why This Matters for Grafema

The original plan would produce **factually incorrect** graph metadata:

```javascript
async function fetchData() {
  throw new ValidationError('bad input');
}
```

**Original plan would set:**
- `hasThrow: true` - WRONG, this function doesn't throw
- `canReject: false` - WRONG, this function rejects

**Correct metadata should be:**
- `hasThrow: false` - Function does not throw (returns Promise)
- `canReject: true` - Function can reject

---

## 2. Control Flow vs Data Flow Impact

### 2.1 Control Flow Metadata (ControlFlowMetadata)

**Current implementation tracks:**
```typescript
export interface ControlFlowMetadata {
  hasBranches: boolean;      // Has if/switch statements
  hasLoops: boolean;         // Has any loop type
  hasTryCatch: boolean;      // Has try/catch blocks
  hasEarlyReturn: boolean;   // Has return before function end
  hasThrow: boolean;         // Has throw statements
  cyclomaticComplexity: number;
}
```

**Recommendation: Extend with async-aware fields:**
```typescript
export interface ControlFlowMetadata {
  // ... existing fields ...
  hasThrow: boolean;           // Sync throw in sync function only
  canReject: boolean;          // NEW: Has rejection patterns
  hasAsyncThrow: boolean;      // NEW: throw in async function (= rejection)
}
```

**Rules for setting these fields:**

| Situation | hasThrow | canReject | hasAsyncThrow |
|-----------|----------|-----------|---------------|
| `throw` in sync function | true | false | false |
| `throw` in async function | false | true | true |
| `Promise.reject()` anywhere | false | true | false |
| `reject()` in executor | false | true | false |

### 2.2 Data Flow (Edges)

**Current edges:**
- `THROWS` - Declared but not implemented (from function to error class)
- `RESOLVES_TO` (REG-334) - From resolve/reject CALL to Promise constructor

**Proposed edges:**
- `REJECTS` - From async function to error class it can reject with
- Keep `RESOLVES_TO` with `isReject: true` for Promise executor data flow

**The distinction:**
- `RESOLVES_TO` tracks **data flow** - where does the rejected value come from
- `REJECTS` tracks **error typing** - what error class can this function reject

These are complementary, not duplicative.

---

## 3. Call Semantics: Sync vs Async

### 3.1 How Await Transforms Semantics

**Critical finding from CatchJS research:**

> "The await keyword converts promise rejections to catchable errors, but return does not."

This means:

```javascript
async function caller() {
  try {
    await asyncFn();    // If asyncFn rejects, caught here
  } catch (e) {
    // Can catch rejections
  }
}

async function caller2() {
  try {
    return asyncFn();   // If asyncFn rejects, NOT caught here!
  } catch (e) {
    // Will NOT catch
  }
}
```

### 3.2 Should Grafema Distinguish Sync vs Async CALLS?

**Analysis:**

The current `CALLS` edge connects:
- FUNCTION (caller) -> FUNCTION (callee)
- CALL node -> FUNCTION (callee)

**Question:** Should we add metadata about whether the call is awaited?

**Recommendation:** Yes, but as **edge metadata, not new edge type**:

```typescript
// CALLS edge with async metadata
CALLS {
  isAwaited: boolean;    // Call is wrapped in await
  isAsyncCallee: boolean; // Callee is async function (if known)
}
```

**Rationale:** This enables queries like:
- "Find all async function calls that are NOT awaited" (potential bug pattern)
- "Find all calls to async functions" (for rejection tracking)

---

## 4. Exception Propagation Tracing

### 4.1 The Core Question

When tracing "what can this function reject", we need to follow the call chain:

```javascript
async function a() {
  return await b();  // If b rejects, a rejects with same error
}

async function b() {
  throw new ValidationError('bad');  // a can reject with ValidationError
}

async function c() {
  try {
    return await a();
  } catch (e) {
    return 'default';  // c does NOT reject with this error
  }
}
```

### 4.2 REJECTS Edge Propagation Rules

**Direct rejection:**
```
FUNCTION[b] --REJECTS--> CLASS[ValidationError]
  (because b has `throw new ValidationError()`)
```

**Propagation through await:**
```
FUNCTION[a] --REJECTS--> CLASS[ValidationError]
  (because a awaits b which can reject with ValidationError)
```

**Caught rejection (no edge):**
```
// c does NOT have REJECTS edge to ValidationError
// because it catches and handles the error
```

### 4.3 Implementation Implications

Tracking propagation requires:
1. **Within-file analysis** (Phase 1): Direct `throw`/`reject()` patterns
2. **Cross-file enrichment** (Phase 2): Follow CALLS edges to propagate REJECTS

**This is similar to how Grafema already handles data flow:**
- Phase 1: Local analysis creates nodes/edges
- Enrichment phase: Cross-file resolution

**MVP recommendation:**
- Phase 1: Track direct rejection patterns only
- Future: Add cross-file REJECTS propagation in enrichment

---

## 5. Implementation Recommendations

### 5.1 Core Changes to Original Plan

**Change 1: Remove synthetic builtin CLASS nodes**

As Steve and Vadim identified, creating phantom `CLASS:Error:builtin` nodes violates graph integrity. Instead:

```typescript
// Store builtin errors in metadata, not edges
export interface ControlFlowMetadata {
  // ... existing ...
  canReject: boolean;
  rejectedBuiltinErrors?: string[];  // ['Error', 'TypeError', 'ValidationError']
}
```

Only create `REJECTS` edges when target CLASS node exists in codebase.

**Change 2: Add async-aware throw tracking**

In `analyzeFunctionBody`, when processing `ThrowStatement`:

```typescript
ThrowStatement: (throwPath: NodePath<t.ThrowStatement>) => {
  // ... existing nested function check ...

  // Check if we're in an async function
  const containingFunc = functions.find(f =>
    f.file === module.file && f.line <= getLine(throwNode)
  );

  if (containingFunc?.async) {
    // This is a rejection, not a throw
    controlFlowState.canReject = true;
    controlFlowState.hasAsyncThrow = true;
    // DON'T set hasThrow = true
  } else {
    // Normal sync throw
    controlFlowState.hasThrow = true;
  }
}
```

**Change 3: Track throw in async as REJECTS edge**

When `throw new ErrorClass()` is in async function:
- Create `RejectionPatternInfo` with `rejectionType: 'async_throw'`
- Create `REJECTS` edge from function to error class

**Change 4: Optimize class lookup**

Replace O(r*c) lookup with Map:

```typescript
private bufferRejectionEdges(
  rejectionPatterns: RejectionPatternInfo[],
  classDeclarations: ClassDeclarationInfo[]
): void {
  // O(c) preprocessing
  const classMap = new Map(classDeclarations.map(c => [c.name, c]));

  for (const pattern of rejectionPatterns) {
    const errorClass = classMap.get(pattern.errorClassName);  // O(1)
    if (errorClass) {
      this._bufferEdge({
        type: 'REJECTS',
        src: pattern.functionId,
        dst: errorClass.id,
        metadata: { rejectionType: pattern.rejectionType }
      });
    } else {
      // Builtin error - store in function metadata, no edge
    }
  }
}
```

### 5.2 New Type Definitions

```typescript
// === REJECTION PATTERN INFO (REG-311) ===
export interface RejectionPatternInfo {
  functionId: string;           // Containing FUNCTION node
  errorClassName: string;       // 'Error', 'ValidationError', etc.
  rejectionType:
    | 'promise_reject'          // Promise.reject(new Error())
    | 'executor_reject'         // reject(new Error()) in Promise executor
    | 'async_throw';            // throw new Error() in async function
  file: string;
  line: number;
  column: number;
}

// === EXTENDED CONTROL FLOW METADATA ===
export interface ControlFlowMetadata {
  hasBranches: boolean;
  hasLoops: boolean;
  hasTryCatch: boolean;
  hasEarlyReturn: boolean;
  hasThrow: boolean;            // Sync throw in sync function ONLY
  canReject: boolean;           // NEW: Has any rejection pattern
  hasAsyncThrow?: boolean;      // NEW: throw in async function
  rejectedBuiltinErrors?: string[];  // NEW: ['Error', 'TypeError']
  cyclomaticComplexity: number;
}
```

### 5.3 Test Matrix

| Pattern | hasThrow | canReject | REJECTS edge |
|---------|----------|-----------|--------------|
| `throw` in sync function | true | false | No (use THROWS if implemented) |
| `throw` in async function | false | true | Yes, to error class |
| `Promise.reject(new Error())` | false | true | Yes, to error class |
| `reject(new Error())` in executor | false | true | Yes, to error class |
| `throw` in async, builtin Error | false | true | No (store in metadata) |

---

## 6. Open Questions for User Decision

### Question 1: Scope of async throw tracking

**Option A (Recommended):** Track `throw` in async functions as rejection
- Pros: Semantically correct, fixes Vadim's concern
- Cons: Adds ~1 day to implementation
- Impact: High - fixes fundamental semantic error

**Option B:** Defer async throw tracking to future issue
- Pros: Ships faster
- Cons: Graph will have incorrect `hasThrow=true` for async functions
- Impact: Medium - users get partial incorrect data

**Recommendation:** Option A. This is a semantic correctness issue, not a nice-to-have.

### Question 2: THROWS edge implementation

The `THROWS` edge type is declared but never used. Should REG-311:

**Option A:** Only implement REJECTS edge (async errors)
- Leave THROWS for future sync error tracking

**Option B:** Implement both THROWS and REJECTS
- Complete error tracking in one feature

**Recommendation:** Option A. THROWS for sync errors is orthogonal scope.

### Question 3: await metadata on CALLS edges

Should we track whether calls are awaited?

**Option A:** Yes, add `isAwaited` to CALLS edge metadata
**Option B:** No, defer to future issue

**Recommendation:** Option B. Useful but not blocking for rejection tracking.

---

## Sources

Research grounded in:
- [MDN async function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function)
- [MDN await](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await)
- [CatchJS Error handling with async/await](https://catchjs.com/Docs/AsyncAwait)
- [javascript.info Async/await](https://javascript.info/async-await)
- [Async Await Error Handling - thecodebarbarian](https://thecodebarbarian.com/async-await-error-handling-in-javascript.html)
- [Exploring JavaScript - Async functions](https://exploringjs.com/js/book/ch_async-functions.html)

---

## Architectural Alignment

This analysis aligns with Grafema's core principles:

1. **Reuse Before Build:** Extends existing `ControlFlowMetadata` and RESOLVES_TO infrastructure
2. **Forward Registration:** Analyzer marks data during traversal, no backward scanning
3. **No O(n) iterations:** Integrates into existing AST traversal
4. **Graph integrity:** No phantom nodes, only edges to real CLASS nodes
