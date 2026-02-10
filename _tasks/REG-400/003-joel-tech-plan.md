# Joel Spolsky's Tech Plan: REG-400

## Summary

Fix callback-as-argument function references to create CALLS edges. The fix is in **GraphBuilder.bufferArgumentEdges()** — same analysis phase, single location change.

## Root Cause (Verified)

In `GraphBuilder.bufferArgumentEdges()` (line 1806-1813):
```typescript
if (targetType === 'VARIABLE' && targetName) {
  const varNode = variableDeclarations.find(v => v.name === targetName && v.file === file);
  if (varNode) {
    targetNodeId = varNode.id;
  }
}
```

Two problems:
1. **Function declarations** (`function fn() {}`) don't create VARIABLE nodes — they create FUNCTION nodes. So `variableDeclarations.find()` returns null → no PASSES_ARGUMENT edge → no CALLS edge.
2. **Const-bound functions** (`const fn = () => {}`) DO have VARIABLE/CONSTANT nodes, so PASSES_ARGUMENT is created. But still no CALLS edge is ever created.

## Solution

In `bufferArgumentEdges()`, after the VARIABLE lookup, also check the `functions` array for a matching name. If found:
1. Use the FUNCTION node as PASSES_ARGUMENT target (if no VARIABLE was found)
2. Create a CALLS edge from the call site to the FUNCTION

### Why This Works

- `functions` array is already passed to `bufferArgumentEdges()` (line 1785)
- For `function fn() {}`: function named `fn` is in the array
- For `const fn = () => {}`: arrow function is named `fn` too (FunctionVisitor.ts line 288-292 infers name from variable binding)
- Both cases resolved with same lookup

### What This Doesn't Handle (Future Enhancement)

- `const fn = helper; array.forEach(fn)` — needs value tracking (ASSIGNED_FROM chain)
- `import { fn } from './module'; array.forEach(fn)` — needs cross-file enrichment
- These are Level 2 fixes, not blocking for this task

## Implementation Steps

### Step 1: Write Test (Kent)

File: `test/unit/CallbackFunctionReference.test.js`

Test cases:
1. `function fn() {}; arr.forEach(fn)` → CALLS edge from forEach to fn
2. `const fn = () => {}; arr.forEach(fn)` → CALLS edge from forEach to fn
3. `arr.map(fn)` → same behavior
4. `setTimeout(fn, 100)` → same behavior (fn is first argument)
5. `fn(callback)` → custom HOF also gets CALLS edge
6. Inline callback `forEach(() => {})` → still works (regression check)
7. Unknown variable `forEach(unknownVar)` → no CALLS edge, no crash

### Step 2: Modify GraphBuilder.bufferArgumentEdges() (Rob)

In the `targetType === 'VARIABLE'` branch:
```typescript
if (targetType === 'VARIABLE' && targetName) {
  const varNode = variableDeclarations.find(v =>
    v.name === targetName && v.file === file
  );
  if (varNode) {
    targetNodeId = varNode.id;
  }

  // NEW: Check if this identifier references a function (callback pattern)
  // Handles: forEach(fn), map(fn), setTimeout(fn), customHOF(fn)
  const funcNode = functions.find(f => f.name === targetName && f.file === file);
  if (funcNode) {
    // If no variable found, use function as PASSES_ARGUMENT target
    if (!targetNodeId) {
      targetNodeId = funcNode.id;
    }
    // Create CALLS edge: CALL -> FUNCTION
    this._bufferEdge({
      type: 'CALLS',
      src: callId,
      dst: funcNode.id,
      metadata: { callType: 'callback' }
    });
  }
}
```

### Step 3: Verify with Existing Tests (Rob)

Run existing test suite to ensure no regressions:
- `test/unit/PassesArgument.test.js`
- `test/unit/ReceivesArgument.test.js`
- `test/unit/FunctionCallResolver.test.js`
- All unit tests

## Complexity Analysis

- **Time**: O(1) per argument — one additional `functions.find()` call (linear scan of per-file functions, typically <100)
- **Space**: O(0) — no new data structures
- **Total**: No measurable impact on analysis performance

## Risks

1. **Multiple FUNCTION nodes with same name in file**: Unlikely in real code (same-scope redeclaration is invalid). `functions.find()` returns first match, which is acceptable.
2. **Duplicate CALLS edges**: If `fn(fn)` (function calls itself AND passes itself), two CALLS edges with same src/dst. Harmless.
3. **False positives**: A variable named same as a function but not referencing it. In JS, you can't have both `const fn` and `function fn()` in same scope — syntax error. Safe.
