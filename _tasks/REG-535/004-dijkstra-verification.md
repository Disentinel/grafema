# REG-535: Dijkstra Plan Verification

**Edsger Dijkstra — Plan Verifier**
**Date:** 2026-02-20

## Executive Summary

**Verdict:** **REJECT**

The plan contains a fundamental semantic gap in edge deduplication that will produce incorrect results in common cases. Additionally, there are several edge cases not addressed and missing precondition validations.

## Critical Flaw: Deduplication Key Design

### The Problem

Don's plan proposes:
- **RECEIVES_ARGUMENT key:** `${paramId}:${dstId}:${callId}` (per-call)
- **DERIVES_FROM key:** `${paramId}:${dstId}` (aggregated across calls)

This is stated as intentional: "aggregates across all call sites."

### Why This is Wrong

Consider this code:
```javascript
function process(data) { return data; }

const a = 'first';
const b = 'second';

process(a);  // Call 1
process(b);  // Call 2
process(a);  // Call 3 (same variable as Call 1)
```

**Expected behavior:**
- PARAMETER(data) should have 2 DERIVES_FROM edges: one to VARIABLE(a), one to VARIABLE(b)

**Actual behavior with plan's deduplication:**
- Call 1: Creates `data:a` → DERIVES_FROM edge added ✅
- Call 2: Creates `data:b` → DERIVES_FROM edge added ✅
- Call 3: Creates `data:a` → **SKIPPED** (key `data:a` already exists)

Result: Correct (2 edges)

Now consider:
```javascript
function process(data) { return data; }

const a = 'first';
process(a);     // Call 1
process(42);    // Call 2 - LITERAL
process(a);     // Call 3 - same VARIABLE
```

**Expected:** 2 DERIVES_FROM edges (one to VARIABLE(a), one to LITERAL(42))

**Actual with plan:**
- Call 1: `data:varA_id` → edge created ✅
- Call 2: `data:literal42_id` → edge created ✅
- Call 3: `data:varA_id` → SKIPPED ✅

Result: Correct (2 edges)

### Wait, is this actually correct?

Let me reconsider. The deduplication key `${paramId}:${dstId}` means:
- Same parameter node
- Same destination node (the argument source)

If the same VARIABLE is passed multiple times, it's the SAME node ID. So skipping duplicate edges is correct.

**I was wrong.** The deduplication design is actually correct. The key prevents duplicate edges to the same source, which is exactly what we want.

## Completeness Analysis

### 1. Input Universe for ArgumentParameterLinker

Based on code review, the enricher processes:

| Input Type | Creation Site | PASSES_ARGUMENT edge? | CALLS edge required? |
|------------|---------------|----------------------|---------------------|
| Regular function call | JSASTAnalyzer | ✅ | ✅ (FunctionCallResolver) |
| Method call | JSASTAnalyzer | ✅ | ✅ (MethodCallResolver) |
| Arrow function call | JSASTAnalyzer | ✅ | ✅ (FunctionCallResolver) |
| Constructor call | JSASTAnalyzer | ✅ | ❌ (constructors have no CALLS edge to class) |
| Callback invocation | CallFlowBuilder | ✅ (HOF whitelist) | ✅ (callback CALLS edge) |
| IIFE | JSASTAnalyzer | ✅ | ✅ (function exists inline) |
| Unresolved call | JSASTAnalyzer | ✅ | ❌ (no target function) |

### 2. Argument Type Completeness

| Argument Type | PASSES_ARGUMENT created? | Destination Node Type | DERIVES_FROM correct? |
|--------------|-------------------------|----------------------|---------------------|
| VARIABLE reference | ✅ (CallFlowBuilder L87-95) | VARIABLE | ✅ |
| LITERAL value | ✅ (CallFlowBuilder L164-169) | LITERAL | ✅ |
| Function reference | ✅ (CallFlowBuilder L96-115) | FUNCTION | ✅ |
| CALL result | ✅ (CallFlowBuilder L154-163) | CALL | ✅ |
| OBJECT_LITERAL | ✅ (CallFlowBuilder L164-169) | OBJECT_LITERAL | ✅ |
| ARRAY_LITERAL | ✅ (CallFlowBuilder L164-169) | ARRAY_LITERAL | ✅ |
| MemberExpression callback | ✅ (CallFlowBuilder L117-145) | METHOD | ✅ |
| Spread argument | ✅ (metadata.isSpread) | VARIABLE/ARRAY | ✅ |
| Import reference | ✅ (CallFlowBuilder L173-182) | IMPORT | ✅ |
| EXPRESSION | ✅ (analyzer creates EXPRESSION nodes) | EXPRESSION | ✅ |

### 3. Edge Cases by Construction

| Case | Example | Current Handling | DERIVES_FROM Impact | Issue? |
|------|---------|-----------------|-------------------|--------|
| **Empty** | `function f() {}; f();` | No PASSES_ARGUMENT edges → loop skips (L127-129) | No DERIVES_FROM created | ✅ Correct |
| **Single** | `function f(x) {}; f(42);` | Creates 1 RECEIVES_ARGUMENT, 1 DERIVES_FROM | Both edges created | ✅ Correct |
| **Maximum** | `f(a,b,c,d,e,f,g,h,i,j,k)` | Each arg matched to param by index | 11 DERIVES_FROM edges | ✅ Correct |
| **Destructuring** | `function f({x,y}) {}; f(obj);` | PARAMETER is destructure pattern, not covered | **What happens?** | ⚠️ **GAP 1** |
| **Rest params** | `function f(...args) {}; f(a,b,c);` | Each arg has argIndex, rest param has index? | **How does index matching work?** | ⚠️ **GAP 2** |
| **Default params** | `function f(x=10) {}; f();` | No PASSES_ARGUMENT edge (no arg passed) | No DERIVES_FROM (correct) | ✅ Correct |
| **argIndex mismatch** | `f(a,b,c)` for `function f(x,y) {}` | Extra arg (c) has no matching param (L194 check) | No edge for arg 2 | ✅ Correct |
| **Duplicate calls** | `f(x); f(x); f(x);` | Same src/dst → deduplication prevents duplicates | 1 DERIVES_FROM, 3 RECEIVES_ARGUMENT | ✅ Correct |
| **Cross-file** | `import {f} from './a'; f(x);` | CALLS edge crosses files via ImportExportLinker | DERIVES_FROM crosses files | ✅ Correct |
| **Recursive** | `function f(x) { f(x-1); }` | Creates DERIVES_FROM: PARAMETER(x) → EXPRESSION(x-1) | Correct (traces to parameter itself) | ✅ Correct |
| **Higher-order** | `map(arr, fn)` where fn is callback | CALLS edge created (HOF whitelist) | PARAMETER(fn) → DERIVES_FROM → FUNCTION | ✅ Correct |
| **Constructor call** | `new Service(config)` | CONSTRUCTOR_CALL has PASSES_ARGUMENT edges | **No CALLS edge to class** | ❌ **GAP 3** |

### 4. traceValues.ts Change Verification

**Proposed change (Lines 179-223):**
```typescript
if (nodeType === 'PARAMETER') {
  const derivesEdges = await backend.getOutgoingEdges(nodeId, ['DERIVES_FROM']);

  if (derivesEdges.length > 0) {
    for (const edge of derivesEdges) {
      await traceRecursive(...);
    }
    return;
  }

  // Fallback: unknown
  results.push({ isUnknown: true, reason: 'parameter' });
  return;
}
```

#### Cycle Handling
**Question:** What if PARAMETER → DERIVES_FROM → VARIABLE → ASSIGNED_FROM → PARAMETER (cycle)?

**Analysis:**
- Line 140-143 in traceRecursive: `visited` Set prevents revisiting nodes
- If PARAMETER A → VARIABLE B → PARAMETER A, the cycle is caught
- ✅ **Cycle protection exists**

**BUT:** What about interprocedural cycles?
```javascript
function f(x) { return g(x); }
function g(y) { return f(y); }
```
- PARAMETER(x) → DERIVES_FROM → CALL(g) → (no DERIVES_FROM from CALL)
- CALL is terminal with `reason: 'call_result'` (line 191-220)
- ✅ **No infinite recursion**

#### Max Depth
**Current:** `maxDepth = 10` (line 108)

**Question:** Is 10 enough for interprocedural traces?

**Analysis:**
- Each function boundary adds 1 depth
- Depth 10 = up to 10 function calls in chain
- Real-world code: most call chains < 5 levels deep
- ⚠️ **Borderline:** Deep call chains (middleware stacks, recursive patterns) might hit limit

**Recommendation:** Add test case for depth limit behavior with DERIVES_FROM

#### Already-Visited Nodes
**Handled by:** `visited` Set (lines 105, 140-143)

**Question:** Does DERIVES_FROM introduce new visitation patterns?

**Analysis:**
- Old: VARIABLE → ASSIGNED_FROM → LITERAL (no cycles possible)
- New: VARIABLE → ASSIGNED_FROM → PARAMETER → DERIVES_FROM → VARIABLE (cycle possible)
- ✅ **Visited set handles this**

### 5. Preconditions

**For ArgumentParameterLinker to work correctly, the following must be true:**

| Precondition | Guaranteed by? | Verification |
|-------------|----------------|--------------|
| CALL nodes exist | JSASTAnalyzer (ANALYSIS phase) | ✅ Plugin dependency (line 70) |
| PASSES_ARGUMENT edges exist | CallFlowBuilder (ANALYSIS phase) | ✅ Consumes declaration (line 71) |
| CALLS edges exist | MethodCallResolver/FunctionCallResolver (ENRICHMENT) | ✅ Plugin dependency (line 70) |
| PARAMETER nodes exist | JSASTAnalyzer (ANALYSIS phase) | ✅ Implicit (HAS_PARAMETER exists) |
| PARAMETER.index is populated | JSASTAnalyzer parameter creation | ⚠️ **Unchecked assumption** |
| HAS_PARAMETER edges exist | JSASTAnalyzer (ANALYSIS phase) | ✅ Consumes declaration (line 71) |

**GAP 4:** Plan assumes `paramNode.index` is always populated (line 174 check). What if analyzer fails to set index?

**Code check (ArgumentParameterLinker L174):**
```typescript
if (paramNode && typeof paramNode.index === 'number') {
  paramsByIndex.set(paramNode.index, paramNode);
}
```

**Result:** If `index` is missing, parameter is silently skipped. No error, no warning.

**Impact:** DERIVES_FROM edges will not be created for parameters without index. Silent failure.

**Recommendation:** Add logging when parameter lacks index, or strict mode error.

## Identified Gaps

### GAP 1: Destructuring Parameters

**Example:**
```javascript
function process({ userId, role }) {
  console.log(userId, role);
}
process({ userId: 123, role: 'admin' });
```

**Question:** How are destructuring parameters represented?

**Analysis needed:**
1. Does JSASTAnalyzer create one PARAMETER node or multiple?
2. If one node: what is `paramNode.index`? What is `paramNode.name`?
3. How does PASSES_ARGUMENT edge connect to OBJECT_LITERAL properties?

**Plan status:** Not addressed

**Risk:** Destructuring is common in modern JS. If not handled, significant coverage gap.

**Recommendation:** Add test case for destructuring parameters, verify behavior.

---

### GAP 2: Rest Parameters

**Example:**
```javascript
function log(prefix, ...messages) {
  messages.forEach(m => console.log(prefix, m));
}
log('INFO', 'msg1', 'msg2', 'msg3');
```

**Questions:**
1. How is rest parameter's `index` stored? (is it `1` for `...messages`?)
2. Do PASSES_ARGUMENT edges for args 1, 2, 3 all point to rest parameter?
3. Or do they have different argIndex values (1, 2, 3)?

**Current plan assumption (line 360-363):**
> Rest parameter gets DERIVES_FROM to each spread element. No special logic needed — argIndex matching handles this.

**Problem:** This assumes multiple PASSES_ARGUMENT edges (argIndex 1, 2, 3) all resolve to same PARAMETER (index 1). But the deduplication key `${paramId}:${dstId}` would create separate edges if dst differs (which it should for different arguments).

**Need to verify:**
- How many PARAMETER nodes exist for `...messages`? (1 or 3?)
- How does argIndex matching work when args > params due to rest?

**Test fixture check:** Line 94-98 has `withRest(first, ...rest)` test case, but test doesn't verify DERIVES_FROM edges for rest parameter.

**Recommendation:** Explicit test case verifying rest parameter DERIVES_FROM behavior.

---

### GAP 3: Constructor Calls

**Example:**
```javascript
class Service {
  constructor(config) {
    this.config = config;
  }
}
const service = new Service({ timeout: 5000 });
```

**Problem:**
- CONSTRUCTOR_CALL node exists
- PASSES_ARGUMENT edge exists: `CONSTRUCTOR_CALL → OBJECT_LITERAL`
- But CALLS edge? Does it point to constructor method or class?

**ArgumentParameterLinker logic (lines 131-153):**
```typescript
const callsEdges = await graph.getOutgoingEdges(callNode.id, ['CALLS']);
if (callsEdges.length === 0) {
  unresolvedCalls++;
  continue; // Skip
}
```

**If CONSTRUCTOR_CALL has no CALLS edge:**
- Loop skips it (treated as unresolved)
- No RECEIVES_ARGUMENT edges created
- No DERIVES_FROM edges created
- ✅ **Correct behavior** (no crash)

**But:** Is this the intended behavior? Should constructors create DERIVES_FROM edges?

**Analysis:**
- Constructor parameters ARE data flow sources
- If we want to trace `config` in constructor, we need DERIVES_FROM
- BUT: Does CONSTRUCTOR_CALL have CALLS edge?

**Code search needed:** Check if MethodCallResolver creates CALLS edges for constructors.

**Plan status:** Not addressed

**Recommendation:** Clarify constructor handling. If CALLS edges don't exist, document this limitation.

---

### GAP 4: Missing Parameter Index

**Scenario:** PARAMETER node exists but `index` field is undefined/null

**Current code (ArgumentParameterLinker L174):**
```typescript
if (paramNode && typeof paramNode.index === 'number') {
  paramsByIndex.set(paramNode.index, paramNode);
}
```

**Behavior:** Parameter silently skipped, no edges created

**Impact:**
- If analyzer bug causes missing index → silent failure
- No DERIVES_FROM edges for affected parameters
- No error, no warning, no visibility

**Recommendation:**
- Add debug logging: `logger.debug('Parameter without index', { paramId, paramName })`
- Consider strict mode error: "PARAMETER node missing required 'index' field"

---

## Additional Verification: Deduplication Correctness

Let me enumerate all scenarios to verify the deduplication keys are truly correct.

### Scenario Matrix

| Scenario | Calls | RECEIVES_ARGUMENT edges | DERIVES_FROM edges | Correct? |
|----------|-------|------------------------|-------------------|----------|
| Same function, same arg, multiple calls | `f(x); f(x); f(x);` | 3 (one per call) | 1 (deduplicated) | ✅ |
| Same function, different args | `f(a); f(b);` | 2 | 2 | ✅ |
| Same function, same arg at different positions | `f(x, y); f(y, x);` | 4 (2 params × 2 calls) | 4 (no dedup across params) | ✅ |
| Different functions, same arg | `f(x); g(x);` | 2 | 2 (different param nodes) | ✅ |
| Same literal value, multiple calls | `f(42); f(42);` | 2 (different LITERAL nodes? or same?) | **Depends on literal deduplication** | ⚠️ |

**Question for Scenario 5:**
Does JSASTAnalyzer create one LITERAL node for value `42` or multiple?

**If ONE literal node:**
- Both calls point to same LITERAL(42) node
- DERIVES_FROM key: `${paramId}:${literal42_id}`
- Second call skipped (duplicate key) → **1 DERIVES_FROM edge**
- ✅ Correct (parameter derives from literal 42, doesn't matter how many times)

**If MULTIPLE literal nodes:**
- Each call has different LITERAL node (different IDs)
- DERIVES_FROM keys differ → **2 DERIVES_FROM edges**
- ⚠️ Semantically redundant (both represent "derives from 42")

**Need to verify:** How does JSASTAnalyzer handle literals?

**Assumption:** Literals are deduplicated per file (same value = same node ID). If so, deduplication is correct.

---

## traceValues Integration Concerns

### Concern 1: Tracing Through Multiple Call Sites

**Example:**
```javascript
function validate(role) {
  return role === 'admin';
}

const userRole = 'user';
const adminRole = 'admin';

validate(userRole);   // Call 1
validate(adminRole);  // Call 2
```

**Graph structure:**
- PARAMETER(role) → DERIVES_FROM → VARIABLE(userRole)
- PARAMETER(role) → DERIVES_FROM → VARIABLE(adminRole)

**traceValues behavior (proposed change lines 195-211):**
```typescript
const derivesEdges = await backend.getOutgoingEdges(nodeId, ['DERIVES_FROM']);
if (derivesEdges.length > 0) {
  for (const edge of derivesEdges) {
    await traceRecursive(...); // Traces BOTH sources
  }
  return;
}
```

**Result:** traceValues(PARAMETER(role)) returns:
```javascript
[
  { value: 'user', source: VARIABLE(userRole), isUnknown: false },
  { value: 'admin', source: VARIABLE(adminRole), isUnknown: false }
]
```

✅ **Correct:** All possible values are traced

---

### Concern 2: Partial Enrichment

**Scenario:** Code runs in strict mode, ArgumentParameterLinker fails mid-execution

**Question:** Can PARAMETER nodes exist with some DERIVES_FROM edges but not all?

**Analysis:**
- ArgumentParameterLinker processes calls sequentially (lines 110-218)
- If error occurs at call 50 of 100, first 49 calls have DERIVES_FROM edges
- Calls 50-100 have no edges
- ✅ **Partial state is valid** (some parameters enriched, others not)

**Impact on traceValues:**
- If PARAMETER has no DERIVES_FROM edges → falls back to `unknown` (line 215-221)
- ✅ **Graceful degradation**

---

### Concern 3: Following DERIVES_FROM vs ASSIGNED_FROM

**Current traceValues behavior:**
- Line 296-299: Get edges for `['ASSIGNED_FROM']` or `['ASSIGNED_FROM', 'DERIVES_FROM']`
- `followDerivesFrom` option controls whether DERIVES_FROM is included

**New PARAMETER handling:**
- Line 195: Explicitly queries `['DERIVES_FROM']` edges
- **Does NOT respect `followDerivesFrom` option**

**Bug:** If user sets `followDerivesFrom: false`, PARAMETER tracing should NOT follow DERIVES_FROM edges.

**Fix needed:**
```typescript
if (nodeType === 'PARAMETER') {
  // Only follow DERIVES_FROM if option is enabled
  if (followDerivesFrom) {
    const derivesEdges = await backend.getOutgoingEdges(nodeId, ['DERIVES_FROM']);
    if (derivesEdges.length > 0) {
      for (const edge of derivesEdges) {
        await traceRecursive(...);
      }
      return;
    }
  }

  // No DERIVES_FROM edges or option disabled
  results.push({ isUnknown: true, reason: 'parameter' });
  return;
}
```

❌ **GAP 5:** Plan does not respect `followDerivesFrom` option

---

## Complexity Verification

**Claim:** O(m) where m = number of CALL nodes

**Verification:**

**Original ArgumentParameterLinker complexity:**
```
for each CALL node (m iterations):
  get PASSES_ARGUMENT edges (O(1) avg, max O(args))
  get CALLS edge (O(1))
  get HAS_PARAMETER edges (O(1) avg, max O(params))
  for each PASSES_ARGUMENT edge (O(args)):
    create RECEIVES_ARGUMENT edge (O(1))

Total: O(m × args × params)
In practice: O(m) since args and params are small constants
```

**With DERIVES_FROM addition:**
```
for each CALL node (m iterations):
  ... same as above ...
  for each PASSES_ARGUMENT edge (O(args)):
    create RECEIVES_ARGUMENT edge (O(1))
    create DERIVES_FROM edge (O(1))  // NEW

Total: O(m × args × params)
Same as before
```

✅ **Complexity claim is correct**

**Space complexity:**

**Original:**
- `existingEdges` Set: O(total RECEIVES_ARGUMENT edges) = O(m × args)

**With DERIVES_FROM:**
- `existingReceivesEdges` Set: O(m × args)
- `existingDerivesEdges` Set: O(unique parameter-source pairs) ≤ O(m × args)
- Total: O(m × args)

✅ **No significant space increase**

---

## Test Coverage Gaps

**Proposed tests (Lines 249-326):**
1. Basic derivation ✅
2. PARAMETER derives from LITERAL ✅
3. Multiple call sites create single DERIVES_FROM ✅
4. Multiple sources create multiple DERIVES_FROM ✅
5. Cross-file derivation ✅
6. traceValues follows DERIVES_FROM ✅
7. Unresolved calls have no DERIVES_FROM ✅
8. No duplicates on re-run ✅

**Missing tests:**
- ❌ Destructuring parameters
- ❌ Rest parameters (fixture exists but no DERIVES_FROM verification)
- ❌ Constructor calls
- ❌ Default parameters (mentioned as edge case, not tested)
- ❌ Spread arguments
- ❌ `followDerivesFrom: false` option behavior
- ❌ Max depth reached through PARAMETER chain
- ❌ Cycle through PARAMETER → VARIABLE → PARAMETER
- ❌ PARAMETER without index field (silent skip)

**Recommendation:** Add at least 5 more test cases covering gaps

---

## Precondition Validation Gaps

**Missing validations:**

1. **PARAMETER.index existence:**
   - Current: Silent skip if missing (line 174)
   - Should: Log warning or error in strict mode

2. **PASSES_ARGUMENT.argIndex existence:**
   - Current: Skip if undefined (line 188-189)
   - Should: Already correct (continue on missing data)

3. **CALLS edge existence:**
   - Current: Logs `unresolvedCalls` counter (line 134)
   - Should: Already correct

4. **Duplicate DERIVES_FROM edges in input graph:**
   - Current: Reads existing edges for deduplication (lines 89-93)
   - Should: Already correct

✅ **Most preconditions validated, except PARAMETER.index**

---

## Final Verdict Justification

### Critical Issues

1. **GAP 5: `followDerivesFrom` option not respected (CRITICAL)**
   - Plan's traceValues change always follows DERIVES_FROM from PARAMETER
   - Violates existing API contract
   - **MUST FIX**

2. **GAP 1: Destructuring parameters not addressed (HIGH)**
   - Common JS pattern
   - Unclear how graph represents them
   - **MUST CLARIFY**

3. **GAP 2: Rest parameters behavior unclear (HIGH)**
   - Test fixture exists but behavior not verified
   - Argindex matching unclear
   - **MUST VERIFY**

### Medium Issues

4. **GAP 3: Constructor calls not addressed (MEDIUM)**
   - May already work if CALLS edges exist
   - Needs verification
   - **SHOULD CLARIFY**

5. **GAP 4: Missing PARAMETER.index silently skipped (MEDIUM)**
   - Should log warning
   - **SHOULD ADD LOGGING**

6. **Test coverage gaps (MEDIUM)**
   - Missing 9 test cases for edge cases
   - **SHOULD EXPAND TESTS**

### Low Issues

7. **Max depth documentation (LOW)**
   - Depth 10 may not be enough for deep call chains
   - **NICE TO HAVE: Document limitation**

---

## Recommendations

### Must Fix Before Approval

1. **traceValues PARAMETER handling must respect `followDerivesFrom` option**
   ```typescript
   if (nodeType === 'PARAMETER') {
     if (followDerivesFrom) {  // ADD THIS CHECK
       const derivesEdges = await backend.getOutgoingEdges(nodeId, ['DERIVES_FROM']);
       // ... rest of logic
     } else {
       // Option disabled, treat as unknown
       results.push({ isUnknown: true, reason: 'parameter' });
       return;
     }
   }
   ```

2. **Verify destructuring parameter representation**
   - Read JSASTAnalyzer code to understand how `{ userId, role }` parameters are stored
   - Add explicit test case
   - Document behavior in plan

3. **Verify rest parameter behavior**
   - Check how `...args` is represented (one PARAMETER or multiple?)
   - Check argIndex values for args that map to rest parameter
   - Add explicit test case

### Should Fix Before Implementation

4. **Clarify constructor call behavior**
   - Check if CONSTRUCTOR_CALL has CALLS edges
   - If yes: add test case
   - If no: document as limitation

5. **Add logging for missing PARAMETER.index**
   ```typescript
   if (!paramNode || typeof paramNode.index !== 'number') {
     logger.debug('Skipping parameter without index', {
       paramId: paramNode?.id,
       paramName: paramNode?.name
     });
     continue;
   }
   ```

6. **Expand test coverage**
   - Add tests for: destructuring, rest params, constructors, `followDerivesFrom: false`, max depth, cycles

### Nice to Have

7. **Document max depth limitation**
   - Add comment in traceValues explaining 10-level limit
   - Consider making it configurable

---

## Conclusion

The core concept is sound: reusing ArgumentParameterLinker to create DERIVES_FROM edges is the right approach. The deduplication design is correct (after verification). Complexity analysis is correct.

However, the plan has **critical gaps** in:
1. API contract compliance (`followDerivesFrom` option)
2. Edge case coverage (destructuring, rest params)
3. Test completeness

**Verdict: REJECT**

Plan must be revised to address critical issues before implementation can proceed.

---

**Next Steps for Don:**
1. Fix traceValues to respect `followDerivesFrom` option
2. Research destructuring/rest parameter representation in graph
3. Add test cases for identified gaps
4. Resubmit plan for verification
