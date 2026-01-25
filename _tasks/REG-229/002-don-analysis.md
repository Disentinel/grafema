# Don Melton Analysis: REG-229 Argument-to-Parameter Binding

## Executive Summary

This feature addresses a fundamental gap in Grafema's data flow model: the ability to trace values across function boundaries. Currently, when `processNode(nodeInfo)` is called, we can see the argument passed but cannot connect it to the `data` parameter inside `processNode(data)`.

## Current Architecture Analysis

### 1. CALLS Edge Creation

**Analysis Phase (same-file only):**
```
GraphBuilder.bufferCallSiteEdges():
  - CALL_SITE node created
  - CALLS edge created only if target function is in the same file
  - Uses simple name matching: functions.find(f => f.name === targetFunctionName)
```

**Enrichment Phase (cross-file):**
```
MethodCallResolver:
  - Resolves METHOD_CALL -> CALLS -> METHOD for method calls
  - Builds class method index for resolution
  - Handles this.method() and obj.method() patterns
```

### 2. Parameter Representation

PARAMETER nodes are created during analysis:
- `id`: semantic ID format `{file}:PARAMETER:{name}:{line}:{index}`
- `functionId`: ID of the containing function
- `index`: positional index (0-based)
- `parentFunctionId`: redundant link to parent function

HAS_PARAMETER edges: `FUNCTION --HAS_PARAMETER--> PARAMETER`

### 3. Argument Tracking

PASSES_ARGUMENT edges are created in `bufferArgumentEdges()`:
```
CALL --PASSES_ARGUMENT(metadata: {argIndex})--> argument_source
```

Where argument_source can be: VARIABLE, LITERAL, FUNCTION, OBJECT_LITERAL, ARRAY_LITERAL, CALL (nested)

### 4. The Missing Link

Current state:
```
                     CALLS
CALL_SITE ─────────────────────> FUNCTION
    │                                │
    │ PASSES_ARGUMENT                │ HAS_PARAMETER
    │ (argIndex: 0)                  │ (index: 0)
    ↓                                ↓
VARIABLE (nodeInfo)            PARAMETER (data)
    └─────────────── ??? ───────────┘
```

The missing edge is what connects `nodeInfo` to `data`. This is exactly what REG-229 needs.

## Design Decision: Edge Direction

Two options considered:

**Option A: RECEIVES_ARGUMENT (Parameter ← Argument)**
```
PARAMETER --RECEIVES_ARGUMENT(argIndex)--> argument_source
```
- Semantics: "parameter data receives argument nodeInfo"
- Query pattern: "What values can reach parameter data?" → follow RECEIVES_ARGUMENT from PARAMETER

**Option B: PASSES_TO_PARAMETER (Argument → Parameter)**
```
argument_source --PASSES_TO_PARAMETER(paramIndex)--> PARAMETER
```
- Semantics: "nodeInfo passes to parameter data"
- Query pattern: "Where does nodeInfo go?" → follow PASSES_TO_PARAMETER from argument

**Decision: RECEIVES_ARGUMENT**

Rationale:
1. Edge type already exists in `@grafema/types` (`EDGE_TYPE.RECEIVES_ARGUMENT`)
2. Matches the query pattern most users need: "What can reach this parameter?"
3. More intuitive for backward tracing (taint analysis flows backward)
4. Consistent with existing data flow direction (ASSIGNED_FROM, DERIVES_FROM)

## Implementation Strategy

### Why Enrichment Phase

1. **Cross-file function calls**: Target function may be in a different file
2. **CALLS edges prerequisite**: Need resolved CALLS edge to find target function
3. **All nodes must exist**: Parameters of target function must be created first
4. **Architectural requirement**: Per grafema-cross-file-operations skill

### New Plugin: ArgumentParameterLinker

**Location:** `packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts`

**Priority:** 55 (after MethodCallResolver at 50, before ValueDomainAnalyzer at 65)

**Creates:** `RECEIVES_ARGUMENT` edges

### Algorithm

```
For each CALL node with PASSES_ARGUMENT edges:
  1. Get outgoing CALLS edge to find target function
  2. If no CALLS edge → skip (unresolved call)
  3. Get target function's PARAMETER nodes via HAS_PARAMETER edges
  4. For each PASSES_ARGUMENT edge:
     a. Get argIndex from edge metadata
     b. Find PARAMETER with matching index
     c. Create RECEIVES_ARGUMENT edge: PARAMETER → argument_source
```

### Edge Schema

```typescript
interface ReceivesArgumentEdge extends EdgeRecord {
  type: 'RECEIVES_ARGUMENT';
  src: string;   // PARAMETER node ID
  dst: string;   // argument source ID (VARIABLE, LITERAL, etc.)
  metadata: {
    argIndex: number;      // argument position (0-based)
    callId: string;        // ID of the CALL node (for multi-call scenarios)
    isSpread?: boolean;    // if argument was spread
  };
}
```

### Cases to Handle

1. **Direct function calls:** `processData(items)`
2. **Method calls:** `service.process(data)`
3. **Arrow functions:** `const fn = (x) => x; fn(value)`
4. **Callback arguments:** `array.map(item => process(item))`
5. **Rest parameters:** `function sum(...nums)` with spread args
6. **Missing arguments:** Call has fewer args than params → no edge for missing
7. **Extra arguments:** Call has more args than params → no edge for extra

## Test Strategy

### Test Cases for Kent

1. **Basic binding:**
   ```javascript
   function process(data) { return data; }
   process(userInput);
   // PARAMETER(data) --RECEIVES_ARGUMENT--> VARIABLE(userInput)
   ```

2. **Multi-argument:**
   ```javascript
   function combine(a, b) { return a + b; }
   combine(x, y);
   // PARAMETER(a, index=0) --RECEIVES_ARGUMENT--> VARIABLE(x)
   // PARAMETER(b, index=1) --RECEIVES_ARGUMENT--> VARIABLE(y)
   ```

3. **Method call:**
   ```javascript
   class Service { process(data) {} }
   service.process(userInput);
   // PARAMETER(data) --RECEIVES_ARGUMENT--> VARIABLE(userInput)
   ```

4. **Cross-file:** (requires two fixture files)
   ```javascript
   // a.js
   export function process(data) {}
   // b.js
   import { process } from './a';
   process(value);
   ```

5. **Unresolved call:** (should not crash, just skip)

## Alignment with Vision

This feature directly supports Grafema's core thesis: **AI should query the graph, not read code.**

With RECEIVES_ARGUMENT edges:
- "What values can reach parameter `data`?" → Single graph query
- Taint analysis becomes possible across function boundaries
- Data flow visualization can show complete paths

**Blocker:** REG-222 (grafema schema export) depends on this for data flow analysis.

## Risk Assessment

**Low risk:**
- Non-breaking: adds new edges, doesn't modify existing
- Edge type already exists in type system
- Pattern follows existing enrichment plugins

**Testing requirement:**
- Must verify no performance regression on large codebases
- Edge count will increase (1 edge per argument that maps to parameter)

## Next Steps

1. Joel creates detailed implementation plan
2. Kent writes tests first (TDD)
3. Rob implements ArgumentParameterLinker
4. Verification: `trace` command can follow through function boundaries

---

## Critical Files for Implementation

- `packages/core/src/plugins/enrichment/MethodCallResolver.ts` - Pattern to follow for cross-file edge creation
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Reference for PASSES_ARGUMENT edges (bufferArgumentEdges)
- `packages/types/src/edges.ts` - Edge types including RECEIVES_ARGUMENT
- `packages/core/src/core/nodes/ParameterNode.ts` - Parameter node structure with functionId and index
- `test/unit/PassesArgument.test.js` - Test pattern to follow
