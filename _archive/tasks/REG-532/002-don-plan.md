# REG-532: CALL/CONSTRUCTOR_CALL Missing DERIVES_FROM Edges - Exploration Plan

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-20
**Status:** Exploration Complete

## Problem Summary

~2800 ERR_NO_LEAF_NODE warnings caused by CALL and CONSTRUCTOR_CALL nodes lacking outgoing DERIVES_FROM edges. Data flow tracing dead-ends at these nodes:

```
VARIABLE:x → ASSIGNED_FROM → CALL:foo → (dead end)
```

**Breakdown:**
- CALL → dead end: 2498 cases
- CONSTRUCTOR_CALL → dead end: 296 cases

## 1. Current Edge Creation for CALL Nodes

### Where CALL Nodes Are Created

**File:** `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

CALL nodes are created during AST traversal in two handlers:
- `handleDirectCall()` - for `foo()` calls (line 206-253)
- `handleSimpleMethodCall()` / `handleNestedMethodCall()` - for `obj.method()` calls (line 255-274)

Both create CALL_SITE or METHOD_CALL nodes with metadata but no edges. The nodes are buffered to collections.

### Where CALL Edges Are Created

**File:** `/packages/core/src/plugins/analysis/ast/builders/CallFlowBuilder.ts`

CallFlowBuilder creates two types of edges:

1. **PASSES_ARGUMENT edges** (line 184-196)
   - Direction: `CALL → PASSES_ARGUMENT → argument_node`
   - Created in `bufferArgumentEdges()`
   - Connects call to its arguments (variables, literals, nested calls, etc.)
   - Includes metadata: `{ argIndex, isSpread? }`

2. **CALLS edges** (line 106-112, 136-142)
   - Direction: `CALL → CALLS → FUNCTION`
   - Only for known callback-invoking functions (forEach, map, setTimeout, etc.)
   - Connects callback arguments to the functions they reference

3. **HAS_PROPERTY edges** (line 234-239)
   - For object literal properties
   - Not relevant to CALL data flow

**CoreBuilder** (in `bufferCallSiteEdges()`) also creates:
- `SCOPE → CONTAINS → CALL` - structural edge
- `CALL → CALLS → FUNCTION` - for resolved function targets

### What's Missing

CALL nodes currently have:
- Incoming edges: `VARIABLE → ASSIGNED_FROM → CALL`
- Outgoing edges: `CALL → PASSES_ARGUMENT → arg`, `CALL → CALLS → FUNCTION` (limited cases)

**Missing:** Outgoing DERIVES_FROM edges that enable data flow tracing through the call.

## 2. How DERIVES_FROM Edges Work in the Codebase

### Edge Semantics (from `/packages/types/src/edges.ts`)

```typescript
PASSES_ARGUMENT: 'PASSES_ARGUMENT',  // CALL → argument (call uses this arg)
DERIVES_FROM: 'DERIVES_FROM',        // value → source (value comes from source)
```

**Key difference:**
- `PASSES_ARGUMENT`: "Call receives this argument" (call as consumer)
- `DERIVES_FROM`: "Value originates from this source" (value as product)

### Current DERIVES_FROM Creation Patterns

**ReturnBuilder** (`/packages/core/src/plugins/analysis/ast/builders/ReturnBuilder.ts`):
- Creates EXPRESSION nodes for return values (line 146-160)
- Buffers DERIVES_FROM edges from EXPRESSION to its sources:
  - MemberExpression → object variable (line 180-188)
  - BinaryExpression → left/right operands (line 192-212)
  - ConditionalExpression → consequent/alternate (line 216-236)
  - UnaryExpression → argument (line 240-248)
  - TemplateLiteral → embedded expressions (line 252-263)

**AssignmentBuilder** (`/packages/core/src/plugins/analysis/ast/builders/AssignmentBuilder.ts`):
- Creates DERIVES_FROM for EXPRESSION nodes assigned to variables (line 242-373)
- Same pattern as ReturnBuilder: EXPRESSION → sources
- Also handles VARIABLE assignments with DERIVES_FROM to parameters (line 166-172)

**YieldBuilder** (`/packages/core/src/plugins/analysis/ast/builders/YieldBuilder.ts`):
- Identical pattern to ReturnBuilder for yield expressions

**Pattern Observed:**
DERIVES_FROM edges always flow FROM a computed/derived value TO its input sources.

## 3. Where ERR_NO_LEAF_NODE Warnings Are Generated

**File:** `/packages/core/src/plugins/validation/DataFlowValidator.ts`

**Leaf node types** (line 67-78):
```typescript
const leafTypes = new Set([
  'LITERAL', 'net:stdio', 'db:query', 'net:request',
  'fs:operation', 'event:listener', 'CLASS', 'FUNCTION',
  'METHOD_CALL', 'CALL_SITE'  // ← CALL nodes ARE leaf types!
]);
```

**The Bug:** Line 216-218 has special handling that treats CALL/METHOD_CALL as intermediate nodes:
```typescript
if (startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE') {
  return { found: true, chain: [...chain, '(intermediate node)'] };
}
```

This is AFTER checking for assignment edges (line 212-215), so it only triggers when a CALL has no outgoing ASSIGNED_FROM/DERIVES_FROM edges. The validator expects CALLs to either:
1. Be leaf nodes (have no outgoing data flow edges), OR
2. Have DERIVES_FROM edges to their data sources

**Current state:** CALLs have no outgoing DERIVES_FROM edges, so they appear as dead-ends when traversing backward from a variable.

## 4. Call Graph Data Flow Modeling - Prior Art

Based on research into call graph and data flow analysis:

**Standard patterns** ([Data Flow Graph - Code Property Graph](https://fraunhofer-aisec.github.io/cpg/CPG/specs/dfg/), [CodeQL Data Flow Analysis](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/)):

1. **Interprocedural flow:** Call edges map data from call site to callee function
   - Arguments flow INTO the call (actual → formal parameters)
   - Return value flows OUT of the call (callee → call site)

2. **Data edges:** Relations where data produced by one operation is consumed by another
   - For calls: arguments are consumed, return value is produced

3. **Call graph bindings:** Each call edge must handle name space mapping
   - `unbind_e(x)` maps names from callee back to caller context

**Grafema's current model:**
- PASSES_ARGUMENT handles argument flow IN (actual → formal via CALL)
- Missing: DERIVES_FROM to model return value flow OUT (CALL → callee or arguments)

## 5. Proposed Fix

### Option A: CALL → DERIVES_FROM → arguments + callee (RECOMMENDED)

CALL nodes should have outgoing DERIVES_FROM edges to:
1. All arguments (because call result may depend on argument values)
2. The callee FUNCTION (because call result comes from function's return value)

**Edge semantics:**
```
VARIABLE:result → ASSIGNED_FROM → CALL:foo
CALL:foo → DERIVES_FROM → VARIABLE:arg1  (call depends on arg1)
CALL:foo → DERIVES_FROM → VARIABLE:arg2  (call depends on arg2)
CALL:foo → DERIVES_FROM → FUNCTION:foo   (call derives from function's logic)
```

**Why this works:**
- DERIVES_FROM means "this value's data originates from these sources"
- A call's result logically derives from both its arguments AND the function's implementation
- Matches existing pattern: EXPRESSION nodes have DERIVES_FROM to their input variables
- Enables backward data flow tracing: result → call → arguments → their sources

### Option B: CALL → DERIVES_FROM → callee FUNCTION only

Create DERIVES_FROM edge only to the callee FUNCTION definition, relying on PASSES_ARGUMENT for argument tracking.

**Why not recommended:**
- PASSES_ARGUMENT flows the opposite direction (CALL → arg)
- DataFlowValidator follows DERIVES_FROM/ASSIGNED_FROM for backward tracing
- Would require validator changes to also follow PASSES_ARGUMENT in reverse

### Option C: Enrichment phase using RETURNS edges

Create DERIVES_FROM edges by analyzing RETURNS edges from functions.

**Why not recommended:**
- RETURNS edges may not exist for external/builtin functions
- Requires cross-module analysis
- More complex, harder to maintain

## 6. Implementation Plan

### Phase: Analysis (CallFlowBuilder)

**File:** `/packages/core/src/plugins/analysis/ast/builders/CallFlowBuilder.ts`

**Changes:**

1. **Extend `bufferArgumentEdges()` method** (after line 197):
   - After creating PASSES_ARGUMENT edges, create corresponding DERIVES_FROM edges
   - Direction: `callId → DERIVES_FROM → targetNodeId`
   - Use same target resolution logic already in place

2. **Add DERIVES_FROM to callee function**:
   - When CALLS edge is created (line 106, 136), also create DERIVES_FROM
   - For regular call sites: lookup targetFunction in CoreBuilder.bufferCallSiteEdges
   - Edge: `CALL → DERIVES_FROM → FUNCTION`

**Code changes:**

```typescript
// In bufferArgumentEdges(), after line 195:
if (targetNodeId) {
  // Existing PASSES_ARGUMENT edge
  const edgeData: GraphEdge = {
    type: 'PASSES_ARGUMENT',
    src: callId,
    dst: targetNodeId,
    metadata: { argIndex }
  };
  this.ctx.bufferEdge(edgeData);

  // NEW: Add DERIVES_FROM edge (call result depends on argument)
  this.ctx.bufferEdge({
    type: 'DERIVES_FROM',
    src: callId,
    dst: targetNodeId,
    metadata: { sourceType: 'argument', argIndex }
  });
}
```

```typescript
// In bufferArgumentEdges(), when creating CALLS edge (line 106, 136):
this.ctx.bufferEdge({
  type: 'CALLS',
  src: callId,
  dst: funcNode.id,
  metadata: { callType: 'callback' }
});

// NEW: Add DERIVES_FROM edge (call result comes from function)
this.ctx.bufferEdge({
  type: 'DERIVES_FROM',
  src: callId,
  dst: funcNode.id,
  metadata: { sourceType: 'callee' }
});
```

### CONSTRUCTOR_CALL Handling

**File:** `/packages/core/src/plugins/analysis/ast/builders/AssignmentBuilder.ts`

CONSTRUCTOR_CALL nodes are created in AssignmentBuilder.bufferAssignmentEdges() (line 78-96).

**Current:** Only ASSIGNED_FROM edge: `VARIABLE → ASSIGNED_FROM → CONSTRUCTOR_CALL`

**Add:**
1. DERIVES_FROM to CLASS node: `CONSTRUCTOR_CALL → DERIVES_FROM → CLASS`
2. DERIVES_FROM to constructor arguments (if CallFlowBuilder doesn't handle them)

**Check:** Do CONSTRUCTOR_CALL nodes go through CallFlowBuilder.bufferArgumentEdges()?
- If YES: arguments already handled
- If NO: need to replicate argument DERIVES_FROM logic in AssignmentBuilder

### Edge Cases to Watch

1. **Builtin constructors** (new Set, new Map, new Date):
   - No CLASS node exists in graph
   - Option: Skip DERIVES_FROM to CLASS for `isBuiltin === true`
   - Option: Create synthetic CLASS nodes for builtins

2. **External function calls**:
   - Function definition may not exist in graph
   - Safe to skip DERIVES_FROM to FUNCTION if target not found
   - Arguments still get DERIVES_FROM edges

3. **Dynamic calls** (computed properties, callbacks stored in variables):
   - Callee may not be resolvable statically
   - Still create DERIVES_FROM to arguments
   - Skip DERIVES_FROM to FUNCTION if not found

4. **Spread arguments** (`foo(...args)`):
   - Already tracked with `isSpread` metadata
   - DERIVES_FROM should still point to the spread variable

5. **Nested calls** (`foo(bar())`):
   - Inner call is an argument to outer call
   - PASSES_ARGUMENT: `outer_call → inner_call`
   - DERIVES_FROM: `outer_call → inner_call` (same target, different semantics)
   - Both edges should exist

## 7. Testing Strategy

1. **Unit tests** for CallFlowBuilder:
   - Verify DERIVES_FROM edges created for simple call: `const x = foo(a, b)`
   - Verify DERIVES_FROM to both arguments and function
   - Verify CONSTRUCTOR_CALL: `const s = new Set(arr)`

2. **Integration tests** for DataFlowValidator:
   - ERR_NO_LEAF_NODE count should drop from ~2800 to ~0
   - Verify data flow chain: `result → CALL → arg → arg_source → LITERAL`

3. **Regression tests**:
   - Ensure existing PASSES_ARGUMENT edges still created
   - Ensure CALLS edges unchanged

## 8. Open Questions

1. **Should CONSTRUCTOR_CALL → DERIVES_FROM → CLASS?**
   - Semantically makes sense: instance derives from its class
   - But CLASS nodes may not always exist (builtins, external modules)
   - **Decision needed:** Skip for builtins? Create synthetic nodes?

2. **Should all arguments get DERIVES_FROM or only data arguments?**
   - Current proposal: ALL arguments (literals, variables, calls)
   - Alternative: Skip LITERAL arguments (they're already leaf nodes)
   - **Recommendation:** Include all for consistency with EXPRESSION pattern

3. **Metadata on DERIVES_FROM edges?**
   - Proposed: `{ sourceType: 'argument' | 'callee', argIndex?: number }`
   - Enables queries like "show me all data sources for this call"
   - Distinguishes argument flow from function flow

## 9. Success Criteria

1. ERR_NO_LEAF_NODE warnings drop from ~2800 to near-zero
2. Data flow queries can trace through CALL nodes:
   ```
   VARIABLE:result → ASSIGNED_FROM → CALL:foo
                                     → DERIVES_FROM → VARIABLE:arg
                                                      → ASSIGNED_FROM → LITERAL
   ```
3. Existing PASSES_ARGUMENT and CALLS edges unchanged
4. All tests pass

## 10. Prior Art Sources

- [Data Flow Graph - Code Property Graph](https://fraunhofer-aisec.github.io/cpg/CPG/specs/dfg/)
- [CodeQL Data Flow Analysis](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/)
- [Data-flow analysis - Wikipedia](https://en.wikipedia.org/wiki/Data-flow_analysis)
- [ScienceDirect: Data Flow Graph](https://www.sciencedirect.com/topics/computer-science/data-flow-graph)

## Next Steps

1. **Dijkstra (Architect)** reviews this plan for architectural correctness
2. **Uncle Bob (Code Quality)** reviews for maintainability and clarity
3. **Kent (TDD)** creates test suite BEFORE implementation
4. **Rob (Implementation)** implements changes in CallFlowBuilder + AssignmentBuilder
5. **4-Review** validates final implementation

---

**Don's Assessment:** This is a straightforward fix in the analysis phase. The architecture is sound — DERIVES_FROM edges follow the same pattern as EXPRESSION nodes. Main risk is edge case handling (builtins, external calls), but these can be handled with simple null checks.
