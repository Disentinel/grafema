# REG-535: Add DERIVES_FROM edges from PARAMETER to argument sources

**Don Melton — Tech Lead**
**Date:** 2026-02-20

## Problem Statement

PARAMETER nodes are currently dead ends in data flow tracing. When `traceValues()` encounters a PARAMETER node, it immediately returns `{isUnknown: true, reason: 'parameter'}` without exploring where the actual values come from at call sites.

This blocks critical use cases:
- Cannot trace HTTP request data through route handlers
- Cannot follow user input through function boundaries
- Data flow analysis stops at every function parameter

## Solution Overview

Add DERIVES_FROM edges from PARAMETER to call-site argument sources during the ArgumentParameterLinker enrichment phase. This enables interprocedural data flow analysis through function boundaries.

**Key insight:** ArgumentParameterLinker already iterates CALL nodes and creates RECEIVES_ARGUMENT edges. We extend the exact same loop to also create DERIVES_FROM edges — zero additional iteration cost.

## Prior Art & Research

Based on academic research into interprocedural static analysis:

### Standard Approaches
According to [Parameterized Algorithms for Scalable Interprocedural Data-flow Analysis (arXiv)](https://arxiv.org/abs/2309.11298), interprocedural data-flow analysis can be formalized by the IFDS framework, which expresses many widely-used static analyses including reaching definitions and live variables.

From [Precise interprocedural dataflow analysis via graph reachability (ACM)](https://dl.acm.org/doi/10.1145/199448.199462): "A large class of interprocedural dataflow-analysis problems can be solved precisely in polynomial time by transforming them into a special kind of graph-reachability problem."

The [SVF framework (LLVM)](https://yuleisui.github.io/publications/cc16.pdf) demonstrates that value-flow graphs with parameter-to-argument edges enable scalable interprocedural analysis.

### Key Principle
As noted in [Interprocedural Data Flow Analysis (Cambridge)](https://www.cl.cam.ac.uk/teaching/1011/L111/ip-dfa.pdf): "In the context of interprocedural analysis, every parameter in a called function depends on only a few variables in the call site line of the callee."

This validates our approach: PARAMETER nodes should have DERIVES_FROM edges to the specific argument sources at each call site.

## Architecture Alignment

**✅ Reuse Before Build:** Extends existing ArgumentParameterLinker enricher, adds new edge type consumption to traceValues.ts. No new subsystems.

**✅ Forward Registration:** ArgumentParameterLinker already uses forward registration pattern — analyzers create PASSES_ARGUMENT edges, enricher creates RECEIVES_ARGUMENT/DERIVES_FROM edges.

**✅ Complexity Check:** O(m) where m = number of CALL nodes. Reuses existing iteration from RECEIVES_ARGUMENT creation — no additional passes.

**✅ Plugin Architecture:** Adding support for new frameworks just requires analyzers to create PASSES_ARGUMENT edges. No enricher changes needed.

## Implementation Plan

### Files to Modify

#### 1. ArgumentParameterLinker.ts (PRIMARY CHANGE)
**Location:** `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts`

**Changes:**
- **Line 66-73:** Update metadata to declare DERIVES_FROM creation
  ```typescript
  creates: {
    nodes: [],
    edges: ['RECEIVES_ARGUMENT', 'DERIVES_FROM']  // Add DERIVES_FROM
  },
  consumes: ['PASSES_ARGUMENT', 'CALLS', 'HAS_PARAMETER', 'RECEIVES_ARGUMENT', 'DERIVES_FROM'],  // Add DERIVES_FROM to consumes
  produces: ['RECEIVES_ARGUMENT', 'DERIVES_FROM']  // Add DERIVES_FROM to produces
  ```

- **Line 85-88:** Update counters
  ```typescript
  let callsProcessed = 0;
  let receivesEdgesCreated = 0;  // Rename from edgesCreated
  let derivesEdgesCreated = 0;    // New counter
  let unresolvedCalls = 0;
  let noParams = 0;
  ```

- **Line 98-109:** Extend deduplication to include DERIVES_FROM edges
  ```typescript
  // Build Sets for both edge types
  // RECEIVES_ARGUMENT key: `${paramId}:${dstId}:${callId}`
  const existingReceivesEdges = new Set<string>();
  // DERIVES_FROM key: `${paramId}:${dstId}` (no callId, represents value source not call)
  const existingDerivesEdges = new Set<string>();

  for await (const node of graph.queryNodes({ nodeType: 'PARAMETER' })) {
    const receivesEdges = await graph.getOutgoingEdges(node.id, ['RECEIVES_ARGUMENT']) as ExtendedEdgeRecord[];
    for (const edge of receivesEdges) {
      const callId = edge.callId ?? (edge.metadata?.callId as string | undefined) ?? '';
      existingReceivesEdges.add(`${node.id}:${edge.dst}:${callId}`);
    }

    const derivesEdges = await graph.getOutgoingEdges(node.id, ['DERIVES_FROM']);
    for (const edge of derivesEdges) {
      existingDerivesEdges.add(`${node.id}:${edge.dst}`);
    }
  }
  ```

- **Line 184-217:** Extend edge creation loop to add DERIVES_FROM
  ```typescript
  // 4. For each PASSES_ARGUMENT edge, create RECEIVES_ARGUMENT and DERIVES_FROM edges
  for (const passesEdge of passesArgumentEdges as PassesArgumentEdge[]) {
    const argIndex = passesEdge.argIndex ?? (passesEdge.metadata?.argIndex as number | undefined);
    if (argIndex === undefined) {
      continue;
    }

    const paramNode = paramsByIndex.get(argIndex);
    if (!paramNode) {
      continue; // No parameter for this argument index
    }

    // Create RECEIVES_ARGUMENT edge (existing logic)
    const receivesKey = `${paramNode.id}:${passesEdge.dst}:${callNode.id}`;
    if (!existingReceivesEdges.has(receivesKey)) {
      await graph.addEdge({
        type: 'RECEIVES_ARGUMENT',
        src: paramNode.id,
        dst: passesEdge.dst,
        metadata: {
          argIndex,
          callId: callNode.id
        }
      });
      existingReceivesEdges.add(receivesKey);
      receivesEdgesCreated++;
    }

    // Create DERIVES_FROM edge (NEW)
    // DERIVES_FROM connects PARAMETER to value source (no callId in metadata)
    const derivesKey = `${paramNode.id}:${passesEdge.dst}`;
    if (!existingDerivesEdges.has(derivesKey)) {
      await graph.addEdge({
        type: 'DERIVES_FROM',
        src: paramNode.id,
        dst: passesEdge.dst,
        metadata: {
          argIndex  // Keep argIndex for debugging, but no callId
        }
      });
      existingDerivesEdges.add(derivesKey);
      derivesEdgesCreated++;
    }
  }
  ```

- **Line 220-240:** Update logging and result
  ```typescript
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
  logger.info('Complete', {
    callsProcessed,
    receivesEdgesCreated,
    derivesEdgesCreated,
    unresolvedCalls,
    noParams,
    time: `${totalTime}s`
  });

  return createSuccessResult(
    { nodes: 0, edges: receivesEdgesCreated + derivesEdgesCreated },
    {
      callsProcessed,
      receivesEdgesCreated,
      derivesEdgesCreated,
      unresolvedCalls,
      noParams,
      timeMs: Date.now() - startTime
    },
    errors
  );
  ```

#### 2. traceValues.ts (CONSUMPTION CHANGE)
**Location:** `/Users/vadimr/grafema-worker-6/packages/core/src/queries/traceValues.ts`

**Changes:**
- **Line 179-188:** Remove terminal return for PARAMETER nodes, allow following DERIVES_FROM edges

**Current code (Lines 179-188):**
```typescript
// Terminal: PARAMETER - runtime input
if (nodeType === 'PARAMETER') {
  results.push({
    value: undefined,
    source,
    isUnknown: true,
    reason: 'parameter',
  });
  return;
}
```

**New code:**
```typescript
// PARAMETER - check for DERIVES_FROM edges first
if (nodeType === 'PARAMETER') {
  // Try to follow DERIVES_FROM edges to call-site arguments
  const derivesEdges = await backend.getOutgoingEdges(nodeId, ['DERIVES_FROM']);

  if (derivesEdges.length > 0) {
    // Found call-site sources, trace them
    for (const edge of derivesEdges) {
      await traceRecursive(
        backend,
        edge.dst,
        visited,
        depth + 1,
        maxDepth,
        followDerivesFrom,
        detectNondeterministic,
        results
      );
    }
    return; // Traced through parameter, don't mark as unknown
  }

  // No DERIVES_FROM edges - parameter is truly unknown (unresolved call or no enrichment)
  results.push({
    value: undefined,
    source,
    isUnknown: true,
    reason: 'parameter',
  });
  return;
}
```

**Rationale:** PARAMETER nodes should first try to follow DERIVES_FROM edges. Only if no edges exist should we mark as unknown.

### Deduplication Strategy

**RECEIVES_ARGUMENT:** Same as current implementation
- Key: `${paramId}:${dstId}:${callId}`
- Scoped per call site
- Example: `param1:var2:call3` — param1 receives var2 from call3

**DERIVES_FROM:** Aggregates across all call sites
- Key: `${paramId}:${dstId}`
- No callId — represents "this parameter derives from this value source"
- Example: `param1:var2` — param1 derives from var2 (regardless of which call)

**Why different keys?**
- RECEIVES_ARGUMENT: Call-site specific (used for debugging, trace contexts)
- DERIVES_FROM: Value-source relationship (used for data flow analysis)

If function `f(x)` is called 3 times with same variable `userInput`:
- 3 RECEIVES_ARGUMENT edges (one per call)
- 1 DERIVES_FROM edge (aggregated value source)

### Test Cases to Add

**File:** `/Users/vadimr/grafema-worker-6/test/unit/ParameterDerivesFrom.test.js` (NEW)

Test cases based on existing ReceivesArgument.test.js patterns:

1. **Basic derivation:** PARAMETER derives from VARIABLE
   ```javascript
   const input = 'test';
   function process(data) { return data; }
   process(input);
   // PARAMETER(data) -[DERIVES_FROM]-> VARIABLE(input)
   ```

2. **PARAMETER derives from LITERAL**
   ```javascript
   function process(num) { return num * 2; }
   process(42);
   // PARAMETER(num) -[DERIVES_FROM]-> LITERAL(42)
   ```

3. **Multiple call sites create single DERIVES_FROM edge**
   ```javascript
   const input = 'test';
   function process(data) { return data; }
   process(input);
   process(input);
   process(input);
   // PARAMETER(data) should have 3 RECEIVES_ARGUMENT edges
   // PARAMETER(data) should have 1 DERIVES_FROM edge to VARIABLE(input)
   ```

4. **Multiple sources create multiple DERIVES_FROM edges**
   ```javascript
   const a = 'first';
   const b = 'second';
   function process(data) { return data; }
   process(a);
   process(b);
   // PARAMETER(data) should have 2 DERIVES_FROM edges (one to 'a', one to 'b')
   ```

5. **Cross-file parameter derivation**
   ```javascript
   // a.js
   export function process(data) { return data; }

   // b.js
   import { process } from './a.js';
   const input = 'test';
   process(input);
   // PARAMETER(data) in a.js -[DERIVES_FROM]-> VARIABLE(input) in b.js
   ```

6. **traceValues() follows DERIVES_FROM through PARAMETER**
   ```javascript
   const userInput = 'admin';
   function validate(role) {
     return role === 'admin';
   }
   validate(userInput);

   // traceValues(PARAMETER(role)) should return:
   // [{ value: 'admin', source: VARIABLE(userInput), isUnknown: false }]
   ```

7. **Unresolved calls have no DERIVES_FROM edges**
   ```javascript
   const input = 'test';
   unknownFunction(input);
   // CALL(unknownFunction) has no CALLS edge
   // No PARAMETER nodes to create DERIVES_FROM edges
   ```

8. **No duplicates on re-run**
   ```javascript
   // Run orchestrator twice
   // DERIVES_FROM edge count should stay the same
   ```

### Edge Cases & Gotchas

#### 1. Semantic ID Collisions (v2)
**Issue:** Tests show v2 semantic IDs can collide for parameters with same name in different functions
- Example: `data[in:process]` exists for both standalone `process()` and `Service.process()`
- One parameter gets lost in collision

**Impact:** DERIVES_FROM edges may attach to wrong parameter node

**Mitigation:**
- This is a known v2 semantic ID limitation tracked separately
- DERIVES_FROM implementation is correct, will automatically work when semantic IDs are fixed
- Tests should document this limitation in comments

#### 2. Unresolved Calls
**Current behavior:** ArgumentParameterLinker skips calls with no CALLS edge (lines 132-153)

**Impact on DERIVES_FROM:** No DERIVES_FROM edges created for unresolved calls (correct behavior)

**Test coverage:** Test case 7 verifies this

#### 3. Extra Arguments / Missing Parameters
**Current behavior:**
- Extra args (more args than params): no edges created (line 194 check)
- Missing args (fewer args than params): params with no matching arg get no edges (line 193 check)

**Impact on DERIVES_FROM:** Same behavior, no special handling needed

#### 4. Spread Arguments / Rest Parameters
**Current handling:** `isSpread` flag exists in PassesArgumentEdge (line 51)

**DERIVES_FROM behavior:** Should create edges for spread args like regular args
- Rest parameter gets DERIVES_FROM to each spread element
- No special logic needed — argIndex matching handles this

**Test coverage:** Test case from fixtures line 94-98 (withRest)

#### 5. Async/Promise Tracing
**Existing pattern:** traceValues.ts handles Promise constructors specially (lines 247-293)

**DERIVES_FROM interaction:**
- PARAMETER in async function → DERIVES_FROM → Promise value
- traceValues already follows RESOLVES_TO edges
- No changes needed to Promise handling

#### 6. HTTP Request Tracing
**Existing pattern:** traceValues.ts follows HTTP_RECEIVES edges (lines 193-210)

**DERIVES_FROM interaction:**
- Route handler PARAMETER → DERIVES_FROM → req.body access
- traceValues then follows HTTP_RECEIVES to backend response
- Chain: PARAMETER → [DERIVES_FROM] → req.body → [HTTP_RECEIVES] → backend response

### Complexity Analysis

**Time complexity:** O(m) where m = number of CALL nodes
- Already iterating CALL nodes for RECEIVES_ARGUMENT (lines 110-218)
- Adding DERIVES_FROM edges requires no additional iteration
- Deduplication: Set lookup O(1) per edge

**Space complexity:**
- Two Sets for deduplication: O(p × a) where p = parameters, a = avg call sites per function
- In practice: same order as existing RECEIVES_ARGUMENT edges

**Comparison to alternatives:**
- ❌ Separate enrichment pass: would be O(m) additional complexity
- ✅ Current approach: reuses existing O(m) iteration, zero additional cost

## Testing Strategy

1. **Unit tests (ParameterDerivesFrom.test.js):**
   - 8 test cases covering basic derivation, cross-file, deduplication
   - Reuse test fixture pattern from ReceivesArgument.test.js
   - Match assertion style: `backend.getOutgoingEdges(paramId, ['DERIVES_FROM'])`

2. **Integration test (traceValues.test.ts):**
   - Add test case for tracing through PARAMETER nodes
   - Verify DERIVES_FROM edges are followed
   - Verify unknown fallback when no DERIVES_FROM edges exist

3. **Existing tests should pass:**
   - ReceivesArgument.test.js (no changes to RECEIVES_ARGUMENT logic)
   - traceValues.test.ts (only adds new capability, doesn't break existing)

## Rollout Plan

### Phase 1: Core Implementation
1. Modify ArgumentParameterLinker.ts (metadata, counters, edge creation)
2. Add ParameterDerivesFrom.test.js
3. Run tests, verify DERIVES_FROM edges created correctly

### Phase 2: Consumption
4. Modify traceValues.ts to follow DERIVES_FROM from PARAMETER nodes
5. Add traceValues integration test
6. Verify interprocedural tracing works end-to-end

### Phase 3: Validation
7. Run full test suite (`pnpm build && npm test`)
8. Check pre-existing failures haven't regressed
9. Verify new tests pass

## Success Criteria

✅ DERIVES_FROM edges created from PARAMETER to argument sources
✅ No duplicate edges on re-run
✅ traceValues() follows DERIVES_FROM through PARAMETER nodes
✅ Cross-file parameter derivation works
✅ All existing tests still pass
✅ Zero additional iteration cost (reuses ArgumentParameterLinker loop)

## Risk Assessment

**LOW RISK:**
- Extends existing enricher, no architectural changes
- Reuses proven patterns (RECEIVES_ARGUMENT creation)
- Edge type already defined and consumed by traceValues.ts
- Changes are additive — doesn't break existing functionality

**Potential issues:**
- Semantic ID collisions (v2) — known issue, tracked separately
- Test flakiness from pre-existing failures — document, don't fix in this task

## References

### Academic Sources
- [Parameterized Algorithms for Scalable Interprocedural Data-flow Analysis (arXiv)](https://arxiv.org/abs/2309.11298)
- [Data-flow analysis (Wikipedia)](https://en.wikipedia.org/wiki/Data-flow_analysis)
- [SVF: Interprocedural Static Value-Flow Analysis in LLVM](https://yuleisui.github.io/publications/cc16.pdf)
- [Efficient Interprocedural Data-Flow Analysis (HAL Science)](https://hal.science/hal-03869253/document)
- [Interprocedural Data Flow Analysis (Cambridge)](https://www.cl.cam.ac.uk/teaching/1011/L111/ip-dfa.pdf)
- [Precise interprocedural dataflow analysis via graph reachability (ACM)](https://dl.acm.org/doi/10.1145/199448.199462)

### Codebase
- `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts`
- `/Users/vadimr/grafema-worker-6/packages/core/src/queries/traceValues.ts`
- `/Users/vadimr/grafema-worker-6/test/unit/ReceivesArgument.test.js`
- `/Users/vadimr/grafema-worker-6/packages/types/src/edges.ts` (line 60: DERIVES_FROM definition)

---

**APPROVED FOR IMPLEMENTATION**

This plan follows Grafema's "Reuse Before Build" principle, extends existing infrastructure, and maintains O(m) complexity by reusing the ArgumentParameterLinker iteration. No new subsystems, no hacks, just the right way to enable interprocedural data flow.
