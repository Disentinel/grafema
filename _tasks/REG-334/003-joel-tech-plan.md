# Joel Spolsky - Technical Specification: REG-334 Promise Dataflow Tracking

## Overview

This document expands Don Melton's high-level plan into a detailed technical specification for tracking data flow through Promise `resolve(value)` calls.

**Goal**: When tracing a variable assigned from `new Promise()`, find the actual data sources from `resolve(value)` calls inside the executor callback.

**Current behavior**:
```javascript
const gigs = await new Promise((resolve, reject) => {
  db.all('SELECT * FROM gigs', (err, rows) => {
    resolve(rows);  // <- Data comes from HERE
  });
});
// Tracing gigs: VARIABLE -> CONSTRUCTOR_CALL(Promise) -> DEAD END
```

**Target behavior**:
```javascript
// Tracing gigs: VARIABLE -> CONSTRUCTOR_CALL(Promise) -> RESOLVES_TO -> resolve(rows) -> rows
```

---

## Part 1: New Edge Type - RESOLVES_TO

### 1.1 Add to Known Edge Types

**File**: `/packages/core/src/storage/backends/typeValidation.ts`
**Location**: Line 38, inside `KNOWN_EDGE_TYPES` Set

```typescript
const KNOWN_EDGE_TYPES = new Set<string>([
  // ... existing types ...
  'THROWS', 'REGISTERS_VIEW',
  'GOVERNS', 'VIOLATES', 'HAS_PARAMETER', 'DERIVES_FROM',
  'RESOLVES_TO',  // NEW: Promise resolve() data flow
]);
```

**Complexity**: O(1) - single Set.add operation

### 1.2 Update Plugin Metadata

**File**: `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location**: Line 256-262, inside `metadata.creates.edges`

```typescript
edges: [
  'CONTAINS', 'DECLARES', 'CALLS', 'HAS_SCOPE', 'CAPTURES', 'MODIFIES',
  // ... existing edges ...
  'DECORATED_BY',
  'RESOLVES_TO'  // NEW
]
```

**Complexity**: O(1) - metadata declaration only

---

## Part 2: Promise Executor Context Tracking

### 2.1 Data Structure for Executor Context

**File**: `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location**: Add after line 200 (after TryScopeInfo interface)

```typescript
/**
 * Tracks Promise executor context during function body analysis.
 * Used to detect when resolve/reject calls should create RESOLVES_TO edges.
 *
 * Context is stored per-function scope, allowing nested Promises.
 */
interface PromiseExecutorContext {
  /** ID of the CONSTRUCTOR_CALL node for `new Promise()` */
  constructorCallId: string;
  /** Name of the first parameter (typically 'resolve') */
  resolveName: string;
  /** Name of the second parameter (typically 'reject'), if any */
  rejectName?: string;
  /** File path for edge creation */
  file: string;
  /** Line of the Promise constructor for debugging */
  line: number;
}
```

### 2.2 Context Storage Strategy

**Decision**: Store executor context in a stack to handle nested Promises.

**File**: `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location**: Add to `analyzeFunctionBody` method local state (around line 3500)

```typescript
// Stack of Promise executor contexts (for nested Promises)
// Top of stack is current context
const promiseExecutorStack: PromiseExecutorContext[] = [];
```

**Why a stack?** Consider:
```javascript
const outer = new Promise((resolve1) => {
  const inner = new Promise((resolve2) => {
    resolve2('inner');  // Should link to inner Promise
  });
  resolve1('outer');    // Should link to outer Promise
});
```

---

## Part 3: Detecting Promise Executor Callbacks

### 3.1 Detection Point: NewExpression Handler

**File**: `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location**: Modify `NewExpression` handler in `analyzeFunctionBody` (around line 4230-4332)

**Current flow**:
1. NewExpression handler creates CONSTRUCTOR_CALL node
2. Creates CALL node for semantic tracking
3. Does NOT track executor callback specially

**New flow**:
1. Same as current
2. **NEW**: If `className === 'Promise'` AND first argument is function:
   - Extract `resolve`/`reject` parameter names
   - Push PromiseExecutorContext to stack
   - After traversing executor body, pop context

### 3.2 Implementation Details

**Add to NewExpression handler** (after line 4261, after `constructorCalls.push(...)`):

```typescript
// Check if this is Promise constructor with executor callback
if (className === 'Promise' && newNode.arguments.length > 0) {
  const executorArg = newNode.arguments[0];

  // Only handle inline function expressions (not variable references)
  if (executorArg.type === 'ArrowFunctionExpression' ||
      executorArg.type === 'FunctionExpression') {

    const executorFunc = executorArg as t.ArrowFunctionExpression | t.FunctionExpression;

    // Extract resolve/reject parameter names
    let resolveName: string | undefined;
    let rejectName: string | undefined;

    if (executorFunc.params.length > 0 && t.isIdentifier(executorFunc.params[0])) {
      resolveName = executorFunc.params[0].name;
    }
    if (executorFunc.params.length > 1 && t.isIdentifier(executorFunc.params[1])) {
      rejectName = executorFunc.params[1].name;
    }

    if (resolveName) {
      // Generate CONSTRUCTOR_CALL ID (same logic as line 4250)
      const constructorCallId = ConstructorCallNode.generateId(
        'Promise', module.file, line, column
      );

      promiseExecutorStack.push({
        constructorCallId,
        resolveName,
        rejectName,
        file: module.file,
        line
      });
    }
  }
}
```

### 3.3 Pop Context After Executor Traversal

**Challenge**: The executor function body is traversed by the existing `ArrowFunctionExpression`/`FunctionExpression` handlers. We need to pop the context AFTER that traversal completes.

**Solution**: Use `path.skip()` pattern already used in these handlers. The context should be popped in the handler that processes the executor body.

**Modify ArrowFunctionExpression handler** (around line 4007):

```typescript
// After analyzing executor body, pop Promise context if this was an executor
// Check: is this arrow function the first argument to a NewExpression(Promise)?
const isPromiseExecutor = t.isNewExpression(arrowPath.parent) &&
  t.isIdentifier((arrowPath.parent as t.NewExpression).callee) &&
  ((arrowPath.parent as t.NewExpression).callee as t.Identifier).name === 'Promise' &&
  arrowPath.listKey === 'arguments' &&
  arrowPath.key === 0;

if (isPromiseExecutor && promiseExecutorStack.length > 0) {
  // Context was pushed in NewExpression handler - DON'T pop here
  // We rely on the NewExpression handler popping it
}
```

Actually, simpler approach: Handle executor body traversal INLINE in NewExpression handler:

```typescript
// After pushing context, manually traverse executor body for resolve calls
if (executorFunc.body.type === 'BlockStatement') {
  // The ArrowFunctionExpression/FunctionExpression handlers will process this
  // They'll see the context on the stack when handling CallExpressions
}
// Pop context after NewExpression processing completes
// Note: This happens in the scope exit of the executor function
```

**Better approach**: Track context by CONSTRUCTOR_CALL ID in a Map, not a stack. Then we don't need to worry about pop timing - we just look up by the parent Promise.

### 3.4 Revised Context Strategy - Map by Parent

**File**: `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Instead of stack, use a Map keyed by the function node (or its ID):

```typescript
// Map from function node start position to Promise context
// This allows looking up context when inside executor callbacks
const promiseExecutorContexts: Map<string, PromiseExecutorContext> = new Map();
```

In NewExpression handler:
```typescript
if (className === 'Promise' && resolveName) {
  const funcKey = `${executorFunc.start}:${executorFunc.end}`;
  promiseExecutorContexts.set(funcKey, {
    constructorCallId,
    resolveName,
    rejectName,
    file: module.file,
    line
  });
}
```

When detecting resolve calls in CallExpression handler:
```typescript
// Check if this is a resolve/reject call
// Walk up to find enclosing Promise executor function
let currentFuncPath = callPath.getFunctionParent();
while (currentFuncPath) {
  const funcNode = currentFuncPath.node;
  const funcKey = `${funcNode.start}:${funcNode.end}`;
  const context = promiseExecutorContexts.get(funcKey);

  if (context) {
    // Found! Check if callee matches resolve/reject name
    if (t.isIdentifier(callNode.callee)) {
      if (callNode.callee.name === context.resolveName ||
          callNode.callee.name === context.rejectName) {
        // This is a resolve/reject call - create RESOLVES_TO edge
        // ... (see Part 4)
        break;
      }
    }
  }

  currentFuncPath = currentFuncPath.getFunctionParent();
}
```

**Complexity**: O(d) where d = nesting depth of functions (typically 1-3)

---

## Part 4: Creating RESOLVES_TO Edges

### 4.1 Edge Structure

```typescript
{
  type: 'RESOLVES_TO',
  src: callId,           // ID of the resolve/reject CALL node
  dst: constructorCallId, // ID of the Promise CONSTRUCTOR_CALL node
  metadata: {
    isReject: boolean    // true if this is reject(), false for resolve()
  }
}
```

**Why src=CALL, dst=CONSTRUCTOR_CALL?** This matches the data flow direction - data flows FROM the resolve argument TO the Promise result.

### 4.2 Collection for RESOLVES_TO Edges

**File**: `/packages/core/src/plugins/analysis/ast/types.ts`
**Add new interface** (near other Info interfaces):

```typescript
/**
 * Info for Promise resolution RESOLVES_TO edges.
 * Created when resolve(value) or reject(error) is called inside Promise executor.
 */
export interface PromiseResolutionInfo {
  /** ID of the resolve/reject CALL node */
  callId: string;
  /** ID of the Promise CONSTRUCTOR_CALL node */
  constructorCallId: string;
  /** True if this is reject(), false for resolve() */
  isReject: boolean;
  /** File path */
  file: string;
  /** Line number of resolve/reject call */
  line: number;
}
```

**Add to ASTCollections** (around line 180):

```typescript
export interface ASTCollections {
  // ... existing collections ...
  returnStatements?: ReturnStatementInfo[];
  updateExpressions?: UpdateExpressionInfo[];
  promiseResolutions?: PromiseResolutionInfo[];  // NEW
  // ... rest ...
}
```

### 4.3 Collecting Promise Resolutions

**File**: `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location**: In `analyzeFunctionBody`, in the CallExpression handling section

**Add detection logic** to `handleCallExpression` method or inline CallExpression handler:

```typescript
// After normal CallExpression processing, check for resolve/reject
if (t.isIdentifier(callNode.callee)) {
  const calleeName = callNode.callee.name;

  // Walk up function parents to find Promise executor context
  let funcPath = path.getFunctionParent();
  while (funcPath) {
    const funcNode = funcPath.node;
    const funcKey = `${funcNode.start}:${funcNode.end}`;
    const context = promiseExecutorContexts.get(funcKey);

    if (context) {
      const isResolve = calleeName === context.resolveName;
      const isReject = calleeName === context.rejectName;

      if (isResolve || isReject) {
        // Generate CALL ID for this resolve/reject call
        // Use same ID generation as other CALL nodes
        const callId = scopeTracker
          ? computeSemanticId('CALL', calleeName, scopeTracker.getContext(),
              { discriminator: scopeTracker.getItemCounter(`CALL:${calleeName}`) })
          : `CALL#${calleeName}#${module.file}#${line}:${column}:${callSiteCounterRef.value++}`;

        collections.promiseResolutions ??= [];
        collections.promiseResolutions.push({
          callId,
          constructorCallId: context.constructorCallId,
          isReject,
          file: module.file,
          line: getLine(callNode)
        });

        break; // Found context, stop searching
      }
    }

    funcPath = funcPath.getFunctionParent();
  }
}
```

**Complexity**: O(d) per CallExpression where d = function nesting depth (typically 1-3)

### 4.4 Buffering RESOLVES_TO Edges in GraphBuilder

**File**: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Location**: After line 340 (after `bufferUpdateExpressionEdges`)

**Add new method**:

```typescript
/**
 * Buffer RESOLVES_TO edges for Promise resolution data flow.
 * Links resolve/reject CALL nodes to their parent Promise CONSTRUCTOR_CALL.
 */
private bufferPromiseResolutionEdges(promiseResolutions: PromiseResolutionInfo[]): void {
  for (const resolution of promiseResolutions) {
    this._bufferEdge({
      type: 'RESOLVES_TO',
      src: resolution.callId,
      dst: resolution.constructorCallId,
      metadata: {
        isReject: resolution.isReject
      }
    });
  }
}
```

**Call this method** in `build()` method (around line 345):

```typescript
// 24. Buffer RESOLVES_TO edges for Promise data flow
this.bufferPromiseResolutionEdges(promiseResolutions);
```

**Complexity**: O(r) where r = number of resolve/reject calls (typically 1-2 per Promise)

---

## Part 5: Extending traceValues to Follow RESOLVES_TO

### 5.1 Modification Point

**File**: `/packages/core/src/queries/traceValues.ts`
**Location**: After line 219 (after `// Original behavior - mark as unknown` for CALL/METHOD_CALL)

**Current flow for CALL**:
1. Check for HTTP_RECEIVES edges
2. If found, follow them
3. Otherwise, mark as unknown with reason: 'call_result'

**New flow for CONSTRUCTOR_CALL**:
1. Check if this is Promise constructor
2. If yes, look for incoming RESOLVES_TO edges
3. Follow them to trace actual data sources

### 5.2 Implementation

**Add after line 219**, inside the `if (nodeType === 'CALL' || nodeType === 'METHOD_CALL')` block, OR add a separate block for CONSTRUCTOR_CALL:

Actually, the tracing starts from VARIABLE, which has ASSIGNED_FROM edge to CONSTRUCTOR_CALL. So we need to handle CONSTRUCTOR_CALL type.

**Add new block after line 243** (after OBJECT_LITERAL handling):

```typescript
// Special case: CONSTRUCTOR_CALL for Promise
// Follow RESOLVES_TO edges to find actual data sources
if (nodeType === 'CONSTRUCTOR_CALL') {
  // Check if this is a Promise constructor
  const className = (node as { className?: string }).className;

  if (className === 'Promise') {
    // Look for incoming RESOLVES_TO edges (resolve/reject calls)
    const resolveEdges = await backend.getIncomingEdges?.(nodeId, ['RESOLVES_TO']) ?? [];

    if (resolveEdges.length > 0) {
      // Follow resolve/reject calls to their arguments
      for (const edge of resolveEdges) {
        // edge.src is the resolve(value) CALL node
        // We need to find what value was passed to resolve()
        // The CALL node should have PASSES_ARGUMENT edge to the value
        const argEdges = await backend.getOutgoingEdges(edge.src, ['PASSES_ARGUMENT']);

        for (const argEdge of argEdges) {
          // Check if this is the first argument (argIndex 0)
          const argIndex = (argEdge.metadata as { argIndex?: number })?.argIndex;
          if (argIndex === 0) {
            // Recursively trace the argument value
            await traceRecursive(
              backend,
              argEdge.dst,
              visited,
              depth + 1,
              maxDepth,
              followDerivesFrom,
              detectNondeterministic,
              results
            );
          }
        }
      }
      return; // Traced through resolve, don't mark as unknown
    }
  }

  // Non-Promise constructor or no resolve edges - mark as unknown
  results.push({
    value: undefined,
    source,
    isUnknown: true,
    reason: 'constructor_call',
  });
  return;
}
```

### 5.3 Backend Interface Extension

**File**: `/packages/core/src/queries/types.ts`
**Location**: Update `TraceValuesGraphBackend` interface

```typescript
export interface TraceValuesGraphBackend {
  getNode(id: string): Promise<TraceValuesNode | null>;
  getOutgoingEdges(nodeId: string, edgeTypes: string[] | null): Promise<TraceValuesEdge[]>;
  /** NEW: Get incoming edges to a node (needed for RESOLVES_TO) */
  getIncomingEdges?(nodeId: string, edgeTypes: string[] | null): Promise<TraceValuesEdge[]>;
}
```

**Note**: Made optional with `?` for backward compatibility. If not implemented, RESOLVES_TO tracing won't work but other tracing will.

**Complexity**: O(e) where e = number of RESOLVES_TO edges (typically 1-2 per Promise)

---

## Part 6: Edge Cases and Special Handling

### 6.1 Multiple resolve() Calls

```javascript
new Promise((resolve) => {
  if (condition) {
    resolve('yes');
  } else {
    resolve('no');
  }
});
```

**Handling**: Each resolve() creates its own RESOLVES_TO edge. traceValues will follow ALL incoming RESOLVES_TO edges, returning multiple possible values. This is correct behavior - matches conditional assignment semantics.

### 6.2 Nested Callbacks Inside Executor

```javascript
new Promise((resolve) => {
  db.query('...', (err, rows) => {
    resolve(rows);  // resolve called in nested callback
  });
});
```

**Handling**: The `getFunctionParent()` walk goes through ALL enclosing functions, including the inner callback. It will find the Promise executor context when it reaches that level. This is O(d) where d = nesting depth.

### 6.3 resolve Passed to Another Function

```javascript
new Promise((resolve) => {
  doSomething(resolve);  // resolve passed as argument
});
```

**Handling**: This is OUT OF SCOPE for MVP. We only track direct `resolve(value)` calls where `resolve` is the callee. Alias tracking would require additional data flow analysis.

### 6.4 Destructured resolve

```javascript
new Promise(({ resolve }) => {
  resolve('value');  // resolve from destructured parameter
});
```

**Handling**: OUT OF SCOPE for MVP. Current implementation only handles simple Identifier parameters. Destructuring patterns would require additional parameter extraction logic.

### 6.5 Dynamic resolve Name

```javascript
const r = 'resolve';
new Promise((resolve) => {
  window[r]('value');  // Dynamic call
});
```

**Handling**: OUT OF SCOPE. We only handle direct identifier calls, not computed property access.

---

## Part 7: Test Plan

### 7.1 Unit Tests: Promise Resolution Detection

**File**: `/test/unit/analysis/promise-resolution.test.ts` (new file)

#### Test 1: Simple Promise with inline resolve
```javascript
// Input
const result = new Promise((resolve) => {
  resolve(42);
});

// Expected graph:
// VARIABLE(result) --ASSIGNED_FROM--> CONSTRUCTOR_CALL(Promise)
// CALL(resolve) --RESOLVES_TO--> CONSTRUCTOR_CALL(Promise)
// CALL(resolve) --PASSES_ARGUMENT--> LITERAL(42)
```

#### Test 2: Promise with callback-based API
```javascript
// Input
const data = new Promise((resolve, reject) => {
  fs.readFile('file.txt', (err, content) => {
    if (err) reject(err);
    else resolve(content);
  });
});

// Expected:
// - Two RESOLVES_TO edges (one for resolve, one for reject)
// - Each links to same CONSTRUCTOR_CALL(Promise)
```

#### Test 3: Conditional resolve
```javascript
// Input
const flag = new Promise((resolve) => {
  if (Math.random() > 0.5) {
    resolve('heads');
  } else {
    resolve('tails');
  }
});

// Expected:
// - Two CALL(resolve) nodes at different lines
// - Two RESOLVES_TO edges to same CONSTRUCTOR_CALL
```

#### Test 4: Nested Promise executors
```javascript
// Input
const outer = new Promise((resolveOuter) => {
  const inner = new Promise((resolveInner) => {
    resolveInner('inner value');
  });
  resolveOuter('outer value');
});

// Expected:
// - resolveInner links to inner Promise's CONSTRUCTOR_CALL
// - resolveOuter links to outer Promise's CONSTRUCTOR_CALL
// - No cross-linking
```

### 7.2 Integration Tests: traceValues with Promises

**File**: `/test/unit/queries/traceValues.test.ts` (add new describe block)

#### Test 5: Trace through Promise to literal
```javascript
// Setup graph manually with RESOLVES_TO edges
// Verify traceValues finds the literal value
```

#### Test 6: Trace through Promise to variable
```javascript
// Graph: var -> CONSTRUCTOR_CALL <- RESOLVES_TO <- CALL -> var2 -> LITERAL
// Should trace through entire chain
```

#### Test 7: Multiple resolve paths
```javascript
// Graph with two RESOLVES_TO edges
// Both values should be returned
```

### 7.3 Complexity Verification Tests

#### Test 8: No O(n) iteration
```javascript
// Create graph with 10,000 nodes
// Ensure Promise resolution detection time is constant
// Verify using timing measurements
```

---

## Part 8: Complexity Analysis Summary

| Operation | Complexity | Notes |
|-----------|------------|-------|
| Add RESOLVES_TO to known types | O(1) | Set.add() |
| Detect Promise executor | O(1) | Check className in NewExpression |
| Extract resolve/reject params | O(p) | p = param count (typically 2) |
| Store executor context | O(1) | Map.set() |
| Lookup context for resolve call | O(d) | d = function nesting depth |
| Create RESOLVES_TO edge | O(1) | Collection push |
| Buffer edges in GraphBuilder | O(r) | r = resolve/reject calls |
| traceValues: follow RESOLVES_TO | O(e) | e = edges (typically 1-2) |
| **Total per-file overhead** | O(r * d) | r=resolutions, d=nesting |

**No O(n) iterations over all nodes** - This implementation follows forward-registration pattern:
- Analyzer marks data during normal traversal (doesn't scan for Promises)
- GraphBuilder buffers edges from collection (doesn't search for patterns)
- traceValues follows edges from specific node (doesn't scan all nodes)

---

## Part 9: Implementation Order

### Phase 1: Infrastructure (0.5 day)
1. Add `RESOLVES_TO` to `typeValidation.ts`
2. Add `PromiseResolutionInfo` to `types.ts`
3. Add `promiseResolutions` to `ASTCollections`
4. Update JSASTAnalyzer metadata

### Phase 2: Detection (1 day)
1. Add `PromiseExecutorContext` interface
2. Add context Map to `analyzeFunctionBody`
3. Detect Promise executor in `NewExpression` handler
4. Store context in Map

### Phase 3: Edge Creation (0.5 day)
1. Add resolve/reject detection in CallExpression handling
2. Populate `promiseResolutions` collection
3. Add `bufferPromiseResolutionEdges` to GraphBuilder
4. Call buffer method in build()

### Phase 4: traceValues (0.5 day)
1. Add `getIncomingEdges` to backend interface (optional)
2. Add CONSTRUCTOR_CALL handling in traceRecursive
3. Follow RESOLVES_TO edges to find data sources

### Phase 5: Tests (1 day)
1. Unit tests for detection
2. Integration tests for traceValues
3. Complexity verification

**Total estimate**: 3.5 days

---

## Part 10: Files Modified Summary

| File | Changes |
|------|---------|
| `packages/core/src/storage/backends/typeValidation.ts` | Add RESOLVES_TO to known edge types |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add PromiseResolutionInfo, update ASTCollections |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Add executor detection, resolve/reject tracking |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Add bufferPromiseResolutionEdges method |
| `packages/core/src/queries/traceValues.ts` | Handle CONSTRUCTOR_CALL with RESOLVES_TO |
| `packages/core/src/queries/types.ts` | Add optional getIncomingEdges to interface |
| `test/unit/analysis/promise-resolution.test.ts` | New test file |
| `test/unit/queries/traceValues.test.ts` | Add Promise tracing tests |

---

## Appendix A: Alternative Considered - Enricher Approach

Don's plan mentioned Option B (PromiseDataFlowEnricher) as cleaner architecture. Here's why we chose Option A (JSASTAnalyzer extension) for MVP:

**Enricher Pros**:
- Cleaner separation of concerns
- Could be disabled independently
- Sets up for future `.then()` chain support

**Enricher Cons**:
- Requires graph-based scope tracking (complex)
- Would need to re-traverse AST or use expensive graph queries
- Potential O(n) iteration over Promise nodes

**Decision**: MVP in JSASTAnalyzer because:
1. Avoids new O(n) iteration - integrates into existing traversal
2. Has access to AST context during analysis
3. Can be extracted to enricher later with learned patterns

---

## Appendix B: Why Not Track resolve as Regular CALL?

**Question**: resolve() creates a CALL node. Why not just follow CALLS edges?

**Answer**:
1. CALLS edges are for function definition -> call site relationships
2. resolve() doesn't have a function definition in the codebase
3. We need a SEMANTIC edge type that represents "data flows through Promise resolution"
4. RESOLVES_TO explicitly captures this semantic, making queries clearer

---

## Appendix C: Handling getIncomingEdges Absence

If backend doesn't implement `getIncomingEdges`, we can fallback:

```typescript
// Fallback: query all RESOLVES_TO edges and filter
if (!backend.getIncomingEdges) {
  // Would require expensive full edge scan - NOT RECOMMENDED
  // Better: ensure backend implements getIncomingEdges
  results.push({
    value: undefined,
    source,
    isUnknown: true,
    reason: 'constructor_call',
  });
  return;
}
```

RFDB backend already supports incoming edge queries via `get_incoming_edges`, so this should work out of the box.
