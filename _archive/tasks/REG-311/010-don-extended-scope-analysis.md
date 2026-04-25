# Don Melton - Extended Scope Analysis for REG-311

## Executive Summary

This analysis addresses the two features being added to REG-311 scope:
1. **Variable Rejection Tracking**: `reject(err)` where err is a variable
2. **Propagation Through Await**: If `await b()` and b rejects, caller also rejects

Both features require infrastructure extensions beyond the current MVP plan. I recommend including them in REG-311 scope with a phased implementation approach.

---

## 1. Variable Rejection Tracking

### 1.1 Problem Statement

Currently REG-311 only tracks rejection patterns where the error is directly constructed:
```javascript
reject(new ValidationError('fail'));  // TRACKED
throw new Error('fail');              // TRACKED (in async function)
```

What is NOT tracked:
```javascript
function forward(err) {
  return Promise.reject(err);  // err is variable, NOT tracked
}

async function wrapper() {
  try { ... } catch (e) {
    throw e;  // re-throwing caught error, NOT tracked
  }
}
```

### 1.2 Data Flow Cases to Consider

**Case A: Parameter Forwarding**
```javascript
function handleError(err) {
  return Promise.reject(err);
}
// Need: trace PARAMETER -> reject() call
```

**Case B: Catch Block Re-throw**
```javascript
try {
  await riskyOperation();
} catch (e) {
  throw e;  // e is caught exception
}
// Need: understand e comes from riskyOperation()'s rejection
```

**Case C: Variable Assignment**
```javascript
const err = new ValidationError('bad');
reject(err);
// Need: trace VARIABLE -> NewExpression -> ErrorClass
```

### 1.3 Existing Infrastructure Analysis

**DERIVES_FROM edges**: Already track data flow for values.
- `traceValues()` follows `ASSIGNED_FROM` and `DERIVES_FROM` edges
- Can trace from VARIABLE/PARAMETER back to LITERAL/CALL source
- Works within single file during analysis phase

**CATCHES_FROM relationship (NEW CONCEPT)**:
- Catch block parameter gets its value from whatever the try block throws/rejects
- Currently NOT modeled in the graph
- Would require: CATCH_BLOCK.parameter --CATCHES_FROM--> sources of errors in TRY_BLOCK

### 1.4 Proposed Approach

**Phase 1: Simple Variable Tracing** - Analysis Phase
```
When reject(identifier) or throw identifier in async:
1. Check if identifier is a PARAMETER
   -> Set canReject=true, but no REJECTS edge (parameter source unknown statically)
   -> Store rejectionPatterns with rejectionType: 'variable_parameter'

2. Check if identifier traces to NewExpression via ASSIGNED_FROM
   -> Use inline "micro-trace" (max depth 3) during analysis
   -> If finds `new ErrorClass()`, create REJECTS edge
   -> Store rejectionPatterns with rejectionType: 'variable_traced'
```

**Phase 2: Cross-File Variable Resolution** - Enrichment Phase
```
For rejectionPatterns with rejectionType: 'variable_parameter':
1. Find CALLS to this function
2. Follow PASSES_ARGUMENT edges to find actual arguments
3. Trace arguments back to error sources
4. Create REJECTS edges for each discovered error class
```

**Phase 3: Catch Parameter Tracing**
```
New edge type: CATCHES_FROM
CATCH_BLOCK.parameter --CATCHES_FROM--> possible error sources in TRY_BLOCK

When throw/reject in catch block uses catch parameter:
1. Follow CATCHES_FROM to find original error sources
2. Propagate those sources to the outer function's REJECTS edges
```

### 1.5 Implementation Impact

**Analysis Phase Changes:**
- Modify `ThrowStatement` handler to detect variable throws
- Modify `reject()` detection to handle variable arguments
- Add inline micro-trace for local variable resolution

**New Infrastructure Needed:**
- `CATCHES_FROM` edge type
- Enricher for propagating rejection types through call chains

**Complexity:**
- Phase 1: O(1) additional per rejection pattern (micro-trace bounded by depth 3)
- Phase 2: O(calls * depth) during enrichment - acceptable if batched
- Phase 3: Requires new graph structure, additional effort

---

## 2. Propagation Through Await

### 2.1 Problem Statement

When function `a` awaits function `b`, and `b` can reject, then `a` also can reject with the same errors (unless caught).

```javascript
async function a() {
  return await b();  // If b rejects with ValidationError, a also rejects with ValidationError
}

async function b() {
  throw new ValidationError();
}
```

The current plan creates REJECTS edges only for direct rejection patterns. It does NOT propagate rejections through await chains.

### 2.2 Semantic Rules

According to CatchJS and MDN:

1. **await with rejection**: If awaited promise rejects, it throws at the await point
2. **try/catch catches rejections**: If await is inside try block, rejection is caught
3. **return (without await)**: Does NOT catch - rejection propagates to caller's caller

```javascript
// Example propagation rules
async function a() {
  await b();        // If b rejects, a rejects (unless in try/catch)
}

async function c() {
  try {
    await b();      // If b rejects, caught here - c does NOT reject
  } catch (e) {
    // handled
  }
}

async function d() {
  return b();       // If b rejects, d's caller sees rejection
                    // (d's try/catch would NOT catch it)
}
```

### 2.3 Static Analysis Challenges

**Challenge 1: Phase Ordering**
- REJECTS edges need to exist before propagation can happen
- But propagation needs CALLS edges which are created during enrichment
- Solution: Propagation must be a separate enrichment pass AFTER basic REJECTS edges are created

**Challenge 2: Detecting Await Context**
- Need to know if CALL is wrapped in await
- Need to know if await is inside try block
- Current infrastructure: `AwaitExpression` is unwrapped to get the CALL, but await-ness is not stored

**Challenge 3: try/catch Scope Analysis**
- Need to know which awaits are protected by try/catch
- Existing: `TryScopeMap` tracks scope transitions during analysis
- Can determine if CALL is inside TRY_BLOCK scope

### 2.4 Proposed Approach

**Phase 1: Mark Awaited Calls**

Add `isAwaited: boolean` to CALL node metadata:
```typescript
export interface CallSiteInfo {
  // ... existing fields ...
  isAwaited?: boolean;  // NEW: true if wrapped in await expression
  isInsideTry?: boolean;  // NEW: true if inside try block
}
```

Detection in JSASTAnalyzer:
```typescript
CallExpression: (callPath) => {
  const parent = callPath.parentPath;
  const isAwaited = parent?.isAwaitExpression() ?? false;

  callSites.push({
    // ... existing ...
    isAwaited,
    isInsideTry
  });
}
```

**Phase 2: Rejection Propagation Enricher**

New enricher: `RejectionPropagationEnricher`
```
Priority: 70 (after FunctionCallResolver at 80)
Dependencies: FunctionCallResolver (for CALLS edges), basic REJECTS edges

Algorithm:
1. Build index of functions with REJECTS edges
2. For each async function F:
   a. Find all CALLS to other async functions inside F
   b. For each awaited call that is NOT inside try/catch:
      - Get callee function
      - Get callee's REJECTS edges
      - Create REJECTS edges from F to same error classes
      - Mark edge with metadata: { propagatedFrom: calleeId }
3. Iterate until fixpoint (for transitive propagation)
```

**Phase 3 (Optional): Promise.all/race Support**
```javascript
const results = await Promise.all([a(), b(), c()]);
// If any of a, b, c rejects, this rejects
```

Requires:
- Detecting Promise.all/race/allSettled patterns
- Following PASSES_ARGUMENT edges to find array elements
- Propagating rejections from all async functions in the array

### 2.5 Implementation Impact

**Analysis Phase Changes:**
- Add `isAwaited` field to `CallSiteInfo`
- Add `isInsideTry` field to `CallSiteInfo`
- Detect await wrapper in `handleCallExpression`

**Enrichment Phase:**
- New `RejectionPropagationEnricher` plugin
- Must run after CALLS edges are resolved
- Iterative algorithm for transitive propagation

**Complexity:**
- Phase 1: O(1) per call site - trivial
- Phase 2: O(n * m) where n = async functions, m = average CALLS per function
- Fixpoint iteration: Usually converges in 2-3 iterations for typical call graphs

### 2.6 Detecting Try/Catch Protection

Need to track whether an await is "protected" by try/catch.

**Option A: Use existing scopeInfo**
- Each CALL has `parentScopeId`
- Check if parentScopeId is a TRY_BLOCK-body scope
- Requires traversing scope chain to find TRY_BLOCK

**Option B: Add metadata during analysis**
- In `handleCallExpression`, check if we're inside `tryScopeMap` tracking
- Add `isInsideTry: boolean` to CallSiteInfo

**Recommendation: Option B** - more explicit and efficient at query time.

---

## 3. What Existing Infrastructure to Reuse

| Need | Existing Infrastructure | Extend How |
|------|------------------------|------------|
| Trace variable to source | `traceValues()` with ASSIGNED_FROM/DERIVES_FROM | Use inline micro-trace in analyzer |
| Track catch parameters | `CatchBlockInfo.parameterName` | Add CATCHES_FROM edge |
| Detect await context | `unwrapAwaitExpression()` | Store `isAwaited` on CALL node |
| Find calls inside function | GraphBuilder CALLS edges + CONTAINS | Query in enricher |
| Track try/catch scope | `tryScopeMap` in analyzer | Add `isInsideTry` to CallSiteInfo |

---

## 4. Complexity Analysis

### Variable Rejection Tracking

| Component | Complexity | Notes |
|-----------|------------|-------|
| Detect variable in reject/throw | O(1) | Pattern match |
| Inline micro-trace (depth 3) | O(1) | Bounded depth |
| Store rejection patterns | O(r) | r = patterns |
| Cross-file resolution | O(calls * trace_depth) | Enrichment phase |

### Await Propagation

| Component | Complexity | Notes |
|-----------|------------|-------|
| Store isAwaited on CALL | O(1) | During analysis |
| Store isInsideTry on CALL | O(1) | During analysis |
| RejectionPropagationEnricher | O(n * m * i) | n=async funcs, m=calls, i=iterations |
| Typical real-world | O(n * 5 * 3) | ~5 calls per func, 3 iterations |

**Total additional complexity:** No new O(all_nodes) passes. Enricher is O(async_functions) which is typically small.

---

## 5. Impact on Implementation Timeline

### Current Approved Plan: 5 days
- Basic rejection patterns (Promise.reject, executor reject, async throw)
- canReject metadata, REJECTS edges to user-defined classes

### Extended Scope Addition:

| Feature | Effort | Phase |
|---------|--------|-------|
| Variable rejection (simple) | +1 day | Analysis |
| isAwaited on CALL nodes | +0.5 day | Analysis |
| isInsideTry on CALL nodes | +0.5 day | Analysis |
| RejectionPropagationEnricher | +2 days | Enrichment |
| Cross-file variable resolution | +1 day | Enrichment |
| CATCHES_FROM infrastructure | +1.5 days | Analysis + Enrichment |

### **Total Extended Scope: ~11.5 days**

---

## 6. Recommended Implementation Order

### Week 1: Core Analysis Phase (5 days)
1. REJECTS edge type and ControlFlowMetadata extensions
2. Basic rejection patterns (Promise.reject, executor reject, async throw)
3. Variable rejection with micro-trace
4. isAwaited and isInsideTry on CALL nodes
5. Tests for all patterns

### Week 2: Enrichment Phase (5 days)
1. CATCHES_FROM edge type and detection
2. Cross-file variable resolution enricher
3. RejectionPropagationEnricher
4. Integration tests for propagation
5. Final polish and documentation

### Deferred (Optional):
- Promise.all/race support

---

## 7. Architectural Recommendations

### 7.1 Forward Registration Pattern (GOOD)

The approach follows forward registration:
- Analyzer marks rejection patterns as it traverses
- No backward scanning for patterns
- Enricher creates cross-file edges from collected data

### 7.2 Avoid Backward Pattern Scanning (BAD)

Do NOT implement propagation as:
```typescript
// BAD: Scans all async functions looking for CALLS
for each async function F:
  for each call C in F:
    if C calls async function G:
      propagate G's rejections to F
```

Instead:
```typescript
// GOOD: Build index first, then process
const asyncFuncsWithRejects = buildIndex();
for each (F, rejects) in asyncFuncsWithRejects:
  propagateToCallers(F, rejects);
```

### 7.3 Metadata vs Edges

- **isAwaited, isInsideTry**: Store as CALL node metadata (not edges)
- **REJECTS propagation**: Create actual REJECTS edges with `propagatedFrom` metadata
- **CATCHES_FROM**: Should be an edge (enables queries like "what does this catch block catch?")

---

## 8. Sources

- CatchJS - Error handling with async/await
- MDN - async function documentation
- Static Analysis for Asynchronous JavaScript Programs (arXiv)
- CSE 401 - Data Flow Analysis fundamentals
