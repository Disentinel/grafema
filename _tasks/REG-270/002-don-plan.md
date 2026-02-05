# Don Melton Plan: REG-270 - Track Generator Function Yields

**Date:** 2026-02-05
**Status:** APPROVED

## 1. Research Findings

### Prior Art on Generator Yield Tracking

Web research revealed that static analysis of generator functions is a well-understood but nuanced problem:

1. **Flow Type System** ([Flow Blog - Typing Generators](https://flow.org/blog/2015/11/09/Generators/)): Flow models generators with three type parameters: `Generator<Yield, Return, Next>`. This confirms that yields and returns are distinct data flows that should be tracked separately.

2. **MDN yield* Documentation** ([MDN - yield*](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/yield*)): The `yield*` operator delegates to another iterable, creating a chain of control. This is semantically different from `yield` - it's not just yielding a value, it's delegating the entire iteration to another generator.

3. **Control Flow Complexity**: Generators create bidirectional control flow - the caller can send values back into the generator via `next(value)`. However, for REG-270, we focus on the OUTPUT side (what generators yield), not the input side.

**Key Insight:** The existing RETURNS edge pattern in Grafema is directly applicable. `yield value` is semantically similar to `return value` - both create data flow from an expression to a function. The difference is that `yield` can occur multiple times and the function doesn't terminate.

## 2. Current State Analysis

### Existing Generator Support

Grafema already tracks generator functions with the `generator: true` flag on FUNCTION nodes:

**FunctionVisitor.ts (line 236):**
```typescript
(functions as FunctionInfo[]).push({
  ...
  generator: node.generator || false,
  ...
});
```

**FunctionInfo interface (types.ts, line 28):**
```typescript
generator?: boolean;
```

However, **no edges exist** to track what generators yield or delegate to.

### Pattern to Follow: RETURNS Edges

The RETURNS edge implementation provides the exact pattern we need:

1. **Collection Phase** (JSASTAnalyzer):
   - `ReturnStatement` visitor detects return statements
   - Creates `ReturnStatementInfo` with source type (VARIABLE, CALL_SITE, LITERAL, etc.)
   - Stores in `returnStatements` collection

2. **Edge Buffering Phase** (GraphBuilder):
   - `bufferReturnEdges()` processes `ReturnStatementInfo` array
   - Resolves source nodes (variables, calls, literals)
   - Creates `RETURNS` edges: `sourceNode --RETURNS--> FUNCTION`

3. **Types** (types.ts):
   - `ReturnStatementInfo` interface with all necessary metadata
   - Added to `ASTCollections`

### Key Files That Need Changes

| File | Purpose |
|------|---------|
| `packages/types/src/edges.ts` | Add YIELDS and DELEGATES_TO edge types |
| `packages/core/src/storage/backends/typeValidation.ts` | Add new edges to validation set |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add YieldExpressionInfo interface |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Add YieldExpression visitor |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Add bufferYieldEdges() |

## 3. Proposed Approach

### 3.1 Edge Semantics

```
YIELDS         - yieldedValue --YIELDS--> FUNCTION
DELEGATES_TO   - CALL/FUNCTION --DELEGATES_TO--> FUNCTION
```

**Edge Direction Rationale:**
- Following RETURNS pattern: `source --EDGE--> function`
- This allows querying "what does this generator yield?" by following incoming YIELDS edges
- Matches existing data flow conventions in Grafema

### 3.2 Data Structure

```typescript
// New interface in types.ts (following ReturnStatementInfo pattern)
export interface YieldExpressionInfo {
  parentFunctionId: string;          // ID of the containing generator function
  file: string;
  line: number;
  column: number;

  // Distinguishes yield from yield*
  isDelegate: boolean;               // true for yield*, false for yield

  // For regular yield: value type determines source node
  yieldValueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION' | 'NONE';

  // Same fields as ReturnStatementInfo for value resolution
  yieldValueName?: string;           // For VARIABLE
  yieldValueId?: string;             // For LITERAL
  yieldValueLine?: number;           // For CALL_SITE/METHOD_CALL
  yieldValueColumn?: number;
  yieldValueCallName?: string;

  // For EXPRESSION type
  expressionType?: string;
  // ... expression metadata (operator, left/right sources, etc.)

  // For yield* - the delegated generator call info
  delegateCallLine?: number;
  delegateCallColumn?: number;
  delegateTargetName?: string;       // Function name for static resolution
}
```

### 3.3 Implementation Steps

#### Phase 1: Type Definitions
1. Add `YIELDS` and `DELEGATES_TO` to `EDGE_TYPE` in `edges.ts`
2. Add to validation set in `typeValidation.ts`
3. Add `YieldExpressionInfo` interface to `types.ts`
4. Add `yieldExpressions?: YieldExpressionInfo[]` to `ASTCollections`

#### Phase 2: Collection (JSASTAnalyzer)
1. Add `yieldExpressions` array initialization in `analyzeFunctionBody()`
2. Add `YieldExpression` visitor handler (similar to `ReturnStatement`)
3. Detect `isDelegate` from `node.delegate` property
4. Reuse `extractReturnExpressionInfo()` for value extraction (rename to `extractExpressionInfo()`?)

#### Phase 3: Edge Buffering (GraphBuilder)
1. Add `bufferYieldEdges()` method (following `bufferReturnEdges()` pattern)
2. For regular `yield`: create `YIELDS` edge from source to function
3. For `yield*`: create `DELEGATES_TO` edge from call to function
4. Call `bufferYieldEdges()` in `build()` method

#### Phase 4: Tests
1. Create `test/unit/plugins/analysis/ast/yield-edges.test.ts`
2. Test cases:
   - Basic yield with literal
   - Yield with variable
   - Yield with function call result
   - yield* with function call
   - yield* with variable (generator stored in variable)
   - Async generators (for-await-of compatible)
   - Multiple yields in same generator
   - Nested generators (yield from callback)

## 4. Key Design Decisions

### Decision 1: Reuse extractReturnExpressionInfo()
The existing method perfectly handles all expression types (VARIABLE, CALL, LITERAL, EXPRESSION). We can reuse it for yield value extraction.

**Alternative considered:** Create separate method for yields.
**Rejected because:** Would duplicate 100+ lines of logic; yields and returns have identical value resolution needs.

### Decision 2: Edge Direction (source --EDGE--> function)
Following existing RETURNS pattern ensures consistency and enables the same query patterns.

**Alternative considered:** function --YIELDS--> value (like the original issue suggested)
**Rejected because:** Inconsistent with RETURNS; would require different query patterns.

### Decision 3: DELEGATES_TO from CALL node (not FUNCTION)
For `yield* otherGen()`, the DELEGATES_TO edge originates from the CALL node, not directly from the FUNCTION.

**Rationale:** The call site has the specific location; if `otherGen` is resolved, we can add a second edge from FUNCTION to FUNCTION.

### Decision 4: No generator flag verification
We don't verify `generator: true` on the parent function during yield collection. The visitor only fires inside generator functions anyway (Babel will error on yield in non-generator).

## 5. Risks and Considerations

### Risk 1: Yield in Conditional/Loop Context
Yields inside conditionals or loops should all be captured. This is simpler than early return detection since there's no "last yield" concept.

**Mitigation:** The visitor pattern naturally captures all yield expressions.

### Risk 2: yield* with Complex Expressions
```javascript
yield* (condition ? genA() : genB());
```
Creates a conditional expression as the delegate target.

**Mitigation:** For complex expressions, create EXPRESSION node and link to it. The DELEGATES_TO edge goes to the expression; cross-file enrichment can resolve to actual generators later.

### Risk 3: Async Generators
Async generators (`async function*`) work identically to sync generators for yield tracking. No special handling needed.

**Validation:** Test case should verify async generator yields are tracked.

## 6. Complexity Analysis

- **Iteration space:** O(yield expressions in file) - no full-graph scan
- **Extends existing pattern:** No new iteration passes; adds to existing function body analysis
- **Memory:** One YieldExpressionInfo per yield - minimal
- **Edge creation:** O(1) per yield expression

**Assessment:** Follows existing architecture perfectly. Minimal complexity addition.

## 7. Acceptance Criteria Mapping

| Criteria | Implementation |
|----------|----------------|
| YIELDS edges created for yield expressions | `bufferYieldEdges()` creates YIELDS edge |
| DELEGATES_TO edges created for yield* | `bufferYieldEdges()` creates DELEGATES_TO when `isDelegate: true` |
| Generator functions queryable for yield types | Query incoming YIELDS edges to FUNCTION |
| Tests cover yield, yield*, async generators | Comprehensive test file |

## 8. Estimate

| Phase | Effort |
|-------|--------|
| Type definitions | 30 min |
| Collection (JSASTAnalyzer) | 1-2 hours |
| Edge buffering (GraphBuilder) | 1-2 hours |
| Tests | 2-3 hours |
| **Total** | **5-8 hours** |

## Approval

This plan follows the established RETURNS edge pattern exactly, requiring minimal new abstractions. The implementation is well-scoped and aligns with Grafema's architectural principles.

**Recommendation:** APPROVE for implementation.

---

*Don Melton, Tech Lead*
*"I don't care if it works, is it RIGHT?"*
