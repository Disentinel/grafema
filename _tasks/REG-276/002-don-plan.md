# Don Melton - High-Level Plan for REG-276

## Analysis Summary

I've analyzed the current implementation of RETURNS edges (REG-263) and how EXPRESSION nodes are handled in the codebase.

### Current State

1. **RETURNS edges (REG-263)**: Working for simple cases:
   - LITERAL returns: `return 42;`
   - VARIABLE/PARAMETER returns: `return result;`
   - CALL_SITE returns: `return foo();`
   - METHOD_CALL returns: `return obj.method();`

2. **EXPRESSION type is explicitly skipped** in `bufferReturnEdges`:
   ```typescript
   case 'EXPRESSION': {
     // For expressions, we skip complex expressions for now
     // This matches how ASSIGNED_FROM handles expressions
     break;
   }
   ```

3. **ASSIGNED_FROM handles EXPRESSION** correctly by:
   - Creating EXPRESSION nodes via `NodeFactory.createExpressionFromMetadata`
   - Creating DERIVES_FROM edges from EXPRESSION to source variables
   - Creating ASSIGNED_FROM edge from target variable to EXPRESSION

### The Gap

When a function returns a complex expression:
```javascript
function compute(a, b) {
  return a + b;  // BinaryExpression - NO RETURNS edge created
}

function getValue(condition, x, y) {
  return condition ? x : y;  // ConditionalExpression - NO RETURNS edge
}

function getProp(obj) {
  return obj.prop;  // MemberExpression - NO RETURNS edge
}
```

These functions have **zero RETURNS edges**, making data flow analysis incomplete.

## Architectural Decision

**Option A (Recommended): Mirror the ASSIGNED_FROM pattern**

For return expressions, follow the same pattern as `bufferAssignmentEdges`:
1. Create an EXPRESSION node for the return value
2. Create DERIVES_FROM edges from EXPRESSION to source variables/parameters
3. Create RETURNS edge from EXPRESSION to function

This aligns with the existing architecture and ensures consistency.

**Option B (Not recommended): Inline handling**

Add special-case logic for each expression type in `bufferReturnEdges`. This would duplicate code and diverge from the established pattern.

## Plan

### Part 1: Extend ReturnStatementInfo

The current `ReturnStatementInfo` type needs additional fields to carry EXPRESSION metadata. Looking at `VariableAssignmentInfo`, we need:

```typescript
interface ReturnStatementInfo {
  // Existing fields...

  // New fields for EXPRESSION type (matching VariableAssignmentInfo pattern)
  returnValueId?: string;           // Expression node ID (already exists, reuse)
  expressionType?: string;          // Already exists

  // For BinaryExpression/LogicalExpression
  operator?: string;
  leftSourceName?: string;
  rightSourceName?: string;

  // For ConditionalExpression
  consequentSourceName?: string;
  alternateSourceName?: string;

  // For MemberExpression
  object?: string;
  property?: string;
  computed?: boolean;
  objectSourceName?: string;

  // For TemplateLiteral
  expressionSourceNames?: string[];
}
```

### Part 2: Update JSASTAnalyzer (ReturnStatement handling)

Enhance the `ReturnStatement` visitor to collect EXPRESSION metadata:
- Extract operand names for BinaryExpression/LogicalExpression
- Extract consequent/alternate names for ConditionalExpression
- Extract object/property for MemberExpression
- Generate a stable EXPRESSION ID

### Part 3: Update GraphBuilder.bufferReturnEdges

Implement the EXPRESSION case to:
1. Create EXPRESSION node via `NodeFactory.createExpressionFromMetadata`
2. Buffer DERIVES_FROM edges to source variables (following `bufferAssignmentEdges` pattern)
3. Buffer RETURNS edge from EXPRESSION to function

### Part 4: Tests

Update `ReturnStatementEdges.test.js`:
- Change "documented gap" tests to expect RETURNS edges
- Add tests for each expression type (BinaryExpression, ConditionalExpression, MemberExpression)
- Verify DERIVES_FROM edges are created correctly

## Expression Types to Support

| Expression Type | Example | DERIVES_FROM Sources |
|-----------------|---------|---------------------|
| BinaryExpression | `return a + b` | a, b |
| LogicalExpression | `return a && b` | a, b |
| ConditionalExpression | `return c ? x : y` | x, y (not c) |
| MemberExpression | `return obj.prop` | obj |
| TemplateLiteral | `` return `${a} ${b}` `` | a, b |
| UnaryExpression | `return !x` | x |
| NewExpression | `return new Foo()` | Foo (CLASS) |

## Not in Scope (Future Work)

1. **Chained method calls**: `return items.filter().map()` - existing documented gap
2. **Nested expressions**: `return (a + b) * c` - would need recursive traversal
3. **Call expressions within other expressions**: `return foo() + bar()` - complex case

## Files to Modify

1. `packages/core/src/plugins/analysis/ast/types.ts` - Extend ReturnStatementInfo
2. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Collect expression metadata in ReturnStatement visitor
3. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Implement EXPRESSION handling in bufferReturnEdges
4. `test/unit/ReturnStatementEdges.test.js` - Update tests

## Alignment with Vision

This change directly supports Grafema's vision: **AI should query the graph, not read code.**

Without this feature, to answer "What does `compute(a, b)` return?", an agent must read the source code. With this feature, the agent can query:
```
MATCH (fn:FUNCTION {name: 'compute'})<-[r:RETURNS]-(expr:EXPRESSION)-[d:DERIVES_FROM]->(src)
RETURN expr, src
```

And get: "compute returns an expression derived from parameters a and b"

## Risk Assessment

**Low risk**:
- Pattern is well-established (ASSIGNED_FROM)
- Changes are isolated to return statement handling
- Existing tests verify no regressions

**Potential issues**:
- ID generation must be unique per return statement (use line/column in ID)
- Need to handle implicit arrow function returns alongside explicit ReturnStatement
