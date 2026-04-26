# Don Melton - Technical Analysis for REG-311

## 1. Current State of THROWS/canThrow Implementation

**Good news:** `hasThrow` is already implemented in `ControlFlowMetadata` (REG-267).

From `packages/core/src/plugins/analysis/ast/types.ts`:
```typescript
export interface ControlFlowMetadata {
  hasBranches: boolean;
  hasLoops: boolean;
  hasTryCatch: boolean;
  hasEarlyReturn: boolean;
  hasThrow: boolean;           // Already tracks synchronous throw
  cyclomaticComplexity: number;
}
```

The `ThrowStatement` handler in JSASTAnalyzer (line 3804) sets `controlFlowState.hasThrow = true` when a throw statement is encountered.

However, the **THROWS edge** defined in `edges.ts` is NOT currently being created - it's only declared as a type. AST_COVERAGE.md confirms: "ThrowStatement - Not Handled - Could create THROWS edge".

## 2. REG-334 Infrastructure Already Supports reject()

**Critical discovery:** REG-334 already implemented tracking for `reject()` calls inside Promise executors:

- `PromiseResolutionInfo` has an `isReject: boolean` field
- `PromiseExecutorContext` stores `rejectName?: string`
- RESOLVES_TO edges are created with `metadata: { isReject: boolean }`

What's **missing** is:
1. `Promise.reject(error)` static method calls - NOT tracked
2. `canReject` metadata on functions - does NOT exist
3. REJECTS edge type - does NOT exist (only THROWS exists as declared but unused)

## 3. Architectural Analysis

**Pattern 1: reject() inside Promise constructor** - PARTIALLY DONE
- REG-334 creates RESOLVES_TO edges with `isReject: true`
- This tracks data flow but doesn't track ERROR CLASS association

**Pattern 2: Promise.reject(new Error())** - NOT TRACKED
- Static method call, no special handling
- Creates regular CALL node but no error tracking

**Pattern 3: Error-first callbacks** - NOT TRACKED
- `callback(new Error())` pattern
- Difficult to distinguish from legitimate first-argument calls

## 4. Design Decisions

**Question 1: REJECTS vs THROWS edge?**

Recommendation: **Use REJECTS edge type** for async errors, keep THROWS for sync.

Rationale:
- Semantic distinction: `throw` is sync, `reject()` is async
- Query clarity: "what can this function throw?" vs "what can this function reject?"
- Error handling is different: try/catch vs .catch()/.then(_, handler)

**Question 2: How to identify the reject parameter?**

Already solved by REG-334:
```typescript
interface PromiseExecutorContext {
  resolveName: string;
  rejectName?: string;  // Already extracted from 2nd parameter
}
```

**Question 3: What patterns are statically analyzable?**

| Pattern | Analyzable | Notes |
|---------|------------|-------|
| `reject(new Error())` in executor | YES | REG-334 infrastructure |
| `Promise.reject(new Error())` | YES | Static method, NewExpression arg |
| `reject(err)` where err is variable | PARTIAL | Need to trace err to constructor |
| `callback(new Error(), ...)` | LIMITED | Heuristic only, high false positives |

## 5. Proposed Approach: Extend Existing Infrastructure

Following Grafema's "Reuse Before Build" principle:

**DO NOT BUILD:** New error tracking engine
**EXTEND INSTEAD:**
- Add `canReject` to existing `ControlFlowMetadata`
- Add REJECTS edge type to existing edge infrastructure
- Extend `PromiseResolutionInfo` handling for error class extraction
- Add `Promise.reject()` detection to CallExpression handler

## 6. Implementation Plan

### Phase 1: Add canReject to ControlFlowMetadata (0.5 day)

**File:** `/packages/core/src/plugins/analysis/ast/types.ts`

```typescript
export interface ControlFlowMetadata {
  // ... existing fields ...
  hasThrow: boolean;           // Sync throw
  canReject: boolean;          // NEW: Async rejection patterns
  cyclomaticComplexity: number;
}
```

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Add to `controlFlowState`:
```typescript
const controlFlowState = {
  // ... existing fields ...
  hasThrow: false,
  canReject: false  // NEW
};
```

Set `canReject = true` when:
1. `reject()` call detected inside Promise executor (REG-334 context check)
2. `Promise.reject()` static method call detected

### Phase 2: Add REJECTS Edge Type (0.5 day)

**File:** `/packages/types/src/edges.ts`

```typescript
// Errors
THROWS: 'THROWS',
REJECTS: 'REJECTS',  // NEW: Async rejection edge
```

**File:** `/packages/core/src/storage/backends/typeValidation.ts`

Add to KNOWN_EDGE_TYPES Set.

### Phase 3: Track Promise.reject() Static Method (1 day)

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

In CallExpression handler, detect `Promise.reject(arg)`:
```javascript
// Detect Promise.reject(error)
if (t.isMemberExpression(callNode.callee) &&
    t.isIdentifier(callNode.callee.object) &&
    callNode.callee.object.name === 'Promise' &&
    t.isIdentifier(callNode.callee.property) &&
    callNode.callee.property.name === 'reject') {

  controlFlowState.canReject = true;

  // Extract error class from argument
  if (callNode.arguments.length > 0) {
    const arg = callNode.arguments[0];
    if (t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
      // Create REJECTS edge to error class
      // rejectionPatterns.push({ ... });
    }
  }
}
```

### Phase 4: Create REJECTS Edges (1 day)

**New type:** `RejectionPatternInfo`

```typescript
export interface RejectionPatternInfo {
  sourceId: string;           // FUNCTION or CALL node
  errorClassName: string;     // 'Error', 'ValidationError', etc.
  errorClassLine?: number;    // For CLASS lookup
  rejectionType: 'promise_reject' | 'executor_reject';
  file: string;
  line: number;
}
```

**GraphBuilder:** Add `bufferRejectionEdges()` method similar to `bufferPromiseResolutionEdges()`.

### Phase 5: Extend Existing reject() Tracking (0.5 day)

REG-334's reject tracking already works. Extend to:
1. Extract error class from `reject(new ErrorClass())`
2. Create REJECTS edge from containing function to error class
3. Set `canReject = true` on function metadata

### Phase 6: Tests (1 day)

Test cases:
```javascript
// Pattern 1: Promise.reject()
function fail() {
  return Promise.reject(new ValidationError('fail'));
}
// Expected: canReject=true, REJECTS edge to ValidationError

// Pattern 2: reject() in executor
function asyncOp() {
  return new Promise((resolve, reject) => {
    if (bad) reject(new Error('bad'));
  });
}
// Expected: canReject=true, REJECTS edge to Error

// Pattern 3: Nested callbacks
function dbOp() {
  return new Promise((resolve, reject) => {
    db.query((err, data) => {
      if (err) reject(err);  // err is variable, limited tracking
    });
  });
}
// Expected: canReject=true (detection works), REJECTS edge only if err traces to Error

// Pattern 4: Multiple reject paths
function complex() {
  return new Promise((resolve, reject) => {
    if (a) reject(new TypeError());
    if (b) reject(new RangeError());
  });
}
// Expected: Two REJECTS edges to different error classes
```

## 7. Scope Boundaries

**IN SCOPE (MVP):**
- `Promise.reject(new Error())` static method
- `reject(new Error())` inside Promise executor
- `canReject` boolean on function metadata
- REJECTS edge from function to error class

**OUT OF SCOPE (Future):**
- Error-first callback pattern (`callback(new Error())`) - too many false positives
- Tracking `reject(err)` where `err` is a variable (requires full data flow)
- `.catch()` handler detection
- Async/await implicit rejections (`throw` in async function)

## 8. Complexity Analysis

| Operation | Complexity | Notes |
|-----------|------------|-------|
| Detect Promise.reject() | O(1) | Pattern match in CallExpression |
| Detect reject() in executor | O(d) | d = function nesting (REG-334 pattern) |
| Extract error class | O(1) | Check NewExpression argument |
| Create REJECTS edge | O(r) | r = rejection patterns per file |
| Total per-file | O(n * d + r) | n = call sites, d = nesting |

**No new O(n) iterations** - integrates into existing traversal.

## 9. Risk Assessment

| Risk | Mitigation |
|------|------------|
| False positives for Promise.reject | Only track `new ErrorClass()` arguments |
| Missing variable rejections | Document limitation, create future issue |
| Breaking existing tests | Extend existing test patterns |
| Performance regression | Integrated into existing pass |

## 10. Files to Modify

| File | Changes |
|------|---------|
| `packages/types/src/edges.ts` | Add REJECTS edge type |
| `packages/core/src/storage/backends/typeValidation.ts` | Add REJECTS to known types |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add canReject to ControlFlowMetadata, add RejectionPatternInfo |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Detect Promise.reject(), set canReject, collect rejection patterns |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Add bufferRejectionEdges() method |
| `test/unit/plugins/analysis/ast/function-metadata.test.ts` | Add canReject tests |
| `test/unit/analysis/rejection-patterns.test.ts` | New test file |

## 11. Architectural Concerns for Steve + Vadim Review

1. **Should REJECTS semantically differ from RESOLVES_TO with isReject=true?**
   - Current: RESOLVES_TO tracks data flow, isReject is metadata
   - Proposed: REJECTS tracks error CLASS relationship (FUNCTION -> CLASS)
   - These are complementary, not redundant

2. **Error-first callback pattern explicitly OUT OF SCOPE**
   - Too many false positives without semantic understanding
   - Node.js convention, not language feature
   - Can revisit with heuristics + config

3. **canReject vs analyzing isReject on RESOLVES_TO edges?**
   - canReject: Simple boolean for quick filtering
   - RESOLVES_TO.isReject: Detailed data flow tracking
   - Both have value for different query patterns

## Sources

- [ESLint prefer-promise-reject-errors](https://eslint.org/docs/latest/rules/prefer-promise-reject-errors) - Best practices for Promise.reject
- [DrAsync: Identifying and Visualizing Anti-Patterns in Asynchronous JavaScript](https://reallytg.github.io/files/papers/drasync.pdf) - Academic research on async pattern detection
