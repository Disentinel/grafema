# Don Melton - High-Level Plan: REG-135 Computed Property Value Resolution

## Executive Summary

This task requires resolving computed property names (`obj[key]`) when the key variable has a deterministic value. The existing codebase already has **substantial infrastructure** for this exact problem. My analysis reveals we are not building from scratch - we are **completing a partially implemented feature**.

## Current State Analysis

### What Already Exists

1. **`computedPropertyVar` field in `MethodCallInfo`** (types.ts:103-104)
   - Already tracks variable names for computed method calls: `obj[x]()`
   - Pattern: `computed?: boolean; computedPropertyVar?: string | null;`

2. **`ValueDomainAnalyzer`** (ValueDomainAnalyzer.ts)
   - **Full infrastructure for value set tracing** already implemented
   - `getValueSet()` method traces VARIABLE -> LITERAL chains
   - Handles ConditionalExpression (multiple ASSIGNED_FROM edges)
   - Detects nondeterministic sources (PARAMETER, CALL, process.env, req.body, etc.)
   - Returns `{ values: [], hasUnknown: boolean }`
   - Already tested and working (462 lines of tests)

3. **AliasTracker computed property resolution** (AliasTracker.ts:328-361)
   - Already resolves `<computed>` to actual property names via `computedPropertyVar`
   - Single-hop resolution: finds variable, follows ASSIGNED_FROM to LITERAL
   - **Limitation:** Only single-hop, only for method calls

4. **`ObjectMutationInfo`** (types.ts:409-430)
   - Tracks object mutations: `obj.prop = value`, `obj['prop'] = value`
   - **Missing:** `computedPropertyVar` field (unlike MethodCallInfo)
   - Uses `propertyName: '<computed>'` for unknown computed properties

5. **GraphBuilder `bufferObjectMutationEdges`** (GraphBuilder.ts:1294-1346)
   - Creates FLOWS_INTO edges for object mutations
   - Edge already has `mutationType` and `propertyName` in metadata

### The Gap

The missing piece is clear:

| Component | MethodCallInfo (calls) | ObjectMutationInfo (property assignments) |
|-----------|------------------------|-------------------------------------------|
| `computed` flag | Has it | Has implicit (mutationType === 'computed') |
| `computedPropertyVar` | **Has it** | **MISSING** |
| Resolution in enrichment | AliasTracker, ValueDomainAnalyzer | **MISSING** |

**The pattern exists for method calls. We need to extend it to property mutations.**

## Architecture Decision

### Question: New Plugin or Extend Existing?

**Answer: Extend `ValueDomainAnalyzer`**

Reasoning:
1. ValueDomainAnalyzer already has the core value tracing logic
2. It already handles computed member access for method calls
3. Adding property mutation resolution is a natural extension
4. Creating a new plugin would duplicate tracing logic

### Question: Analysis Phase or Enrichment Phase?

**Answer: Both (different responsibilities)**

1. **Analysis Phase (JSASTAnalyzer)**: Capture `computedPropertyVar` in `ObjectMutationInfo`
2. **Enrichment Phase (ValueDomainAnalyzer)**: Resolve the variable to literal values

This matches the existing pattern for MethodCallInfo.

## Detailed Plan

### Phase 1: Extend ObjectMutationInfo (Analysis)

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

Add field to `ObjectMutationInfo`:
```typescript
export interface ObjectMutationInfo {
  // ... existing fields ...
  computedPropertyVar?: string;  // Variable name in obj[x] = value
}
```

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

In `detectObjectPropertyAssignment()`, capture the variable name when property is computed:
```typescript
// Current (line 2394):
propertyName = '<computed>';
mutationType = 'computed';

// Add:
let computedPropertyVar: string | undefined;
if (memberExpr.property.type === 'Identifier') {
  computedPropertyVar = memberExpr.property.name;
}
```

Store it in the mutation object:
```typescript
objectMutations.push({
  // ... existing fields ...
  computedPropertyVar  // NEW
});
```

### Phase 2: Add ResolutionStatus Type

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

```typescript
/**
 * Resolution status for computed property names.
 * Used in edge metadata to indicate how a property name was determined.
 */
export type ResolutionStatus =
  | 'RESOLVED'              // Single deterministic value
  | 'RESOLVED_CONDITIONAL'  // Multiple possible values (ternary, etc.)
  | 'UNKNOWN_PARAMETER'     // Traces to function parameter
  | 'UNKNOWN_RUNTIME'       // Traces to function call
  | 'DEFERRED_CROSS_FILE';  // Requires cross-file analysis
```

### Phase 3: Extend ValueDomainAnalyzer

**File:** `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`

Add new method to resolve computed property mutations:

```typescript
/**
 * Resolve computed property names for object mutations.
 * Updates FLOWS_INTO edge metadata with resolved property names.
 */
async resolveComputedMutations(graph: Graph): Promise<{
  resolved: number;
  conditional: number;
  unknown: number;
}>;
```

Logic:
1. Find FLOWS_INTO edges with `mutationType: 'computed'`
2. For each edge, get the source mutation's `computedPropertyVar`
3. Call existing `getValueSet()` to trace the variable
4. Update edge metadata with resolved `propertyName` and `resolutionStatus`

### Phase 4: Update GraphBuilder Edge Metadata

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

Extend FLOWS_INTO edge to include resolution metadata:
```typescript
const edgeData: GraphEdge = {
  type: 'FLOWS_INTO',
  src: sourceNodeId,
  dst: objectNodeId,
  mutationType,
  propertyName,            // May be '<computed>' initially
  computedPropertyVar,     // NEW: for later resolution
  // After enrichment:
  // resolvedPropertyNames: ['name1', 'name2'],  // Added by ValueDomainAnalyzer
  // resolutionStatus: 'RESOLVED'
};
```

### Phase 5: Tests

**New test file:** `test/unit/ComputedPropertyResolution.test.js`

Test cases (matching acceptance criteria):
1. Direct literal: `const k = 'x'; obj[k] = value`
2. Literal chain: `const a = 'x'; const b = a; obj[b] = value`
3. Ternary: `const k = c ? 'a' : 'b'; obj[k] = value`
4. Parameter: `function f(k) { obj[k] = value }`
5. External call: `const k = getKey(); obj[k] = value`
6. Cross-file (deferred): `const k = imported.KEY; obj[k] = value`

### Phase 6: Integration

In `ValueDomainAnalyzer.execute()`:
```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  // ... existing computed call resolution ...

  // NEW: Resolve computed property mutations
  const mutationStats = await this.resolveComputedMutations(graphTyped);

  return createSuccessResult(
    { nodes: 0, edges: edgesCreated + mutationStats.resolved },
    { ...summary, ...mutationStats }
  );
}
```

## Architecture Alignment

This design aligns with project vision:

1. **Graph-first:** Information is stored in edge metadata, queryable via graph
2. **Follows existing patterns:** Extends `computedPropertyVar` pattern from MethodCallInfo
3. **Uses existing infrastructure:** Leverages ValueDomainAnalyzer's value tracing
4. **Clean separation:** Analysis collects data, enrichment resolves it
5. **No hacks:** Each component has clear responsibility

## Risk Assessment

### Low Risk
- Adding `computedPropertyVar` to `ObjectMutationInfo` (additive change)
- Extending existing test patterns
- Using proven value tracing logic

### Medium Risk
- Edge metadata updates during enrichment (need to verify RFDB supports this)
- Performance impact on large codebases (mitigated: only process computed mutations)

### Questions for Joel (Tech Plan)
1. Does RFDB support updating edge metadata after creation?
   - If not, we may need to store resolution in separate nodes or use a different approach
2. Should resolution status be a separate field or combined with propertyName?
3. Cross-file resolution - defer to Phase 2 or stub out infrastructure now?

## Implementation Order

1. **Types first** - Add `computedPropertyVar` to `ObjectMutationInfo` and `ResolutionStatus`
2. **Analysis** - Capture variable name in JSASTAnalyzer
3. **Tests** - Write tests for expected behavior (TDD)
4. **Enrichment** - Extend ValueDomainAnalyzer
5. **Integration** - Verify end-to-end with full analysis

## Estimated Scope

- Types: ~20 lines
- JSASTAnalyzer: ~15 lines
- ValueDomainAnalyzer: ~80 lines
- GraphBuilder: ~10 lines
- Tests: ~200 lines
- **Total: ~325 lines of new/modified code**

This is a well-scoped feature that builds on solid existing infrastructure.
