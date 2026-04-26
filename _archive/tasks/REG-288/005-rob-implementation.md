# Rob Pike's Implementation Report: REG-288 Update Expression Tracking

## Summary

Implemented first-class graph representation for UpdateExpression (i++, --count) following Joel's technical plan. The implementation creates UPDATE_EXPRESSION nodes with MODIFIES and READS_FROM edges, replacing the old SCOPE-based tracking mechanism.

## Changes Made

### 1. Types (packages/core/src/plugins/analysis/ast/types.ts)

**Added UpdateExpressionInfo interface** (after line 653):
```typescript
export interface UpdateExpressionInfo {
  variableName: string;           // Name of variable being modified
  variableLine: number;           // Line where variable is referenced
  operator: '++' | '--';          // Increment or decrement
  prefix: boolean;                // ++i (true) vs i++ (false)
  file: string;
  line: number;                   // Line of update expression
  column: number;
  parentScopeId?: string;         // Containing scope for CONTAINS edge
}
```

**Added to ASTCollections interface**:
```typescript
updateExpressions?: UpdateExpressionInfo[];
```

**Removed modifies field from ScopeInfo**:
The `modifies?: Array<{ variableId: string; variableName: string; line: number }>` field was removed from ScopeInfo. MODIFIES edges now come from UPDATE_EXPRESSION nodes.

### 2. JSASTAnalyzer (packages/core/src/plugins/analysis/JSASTAnalyzer.ts)

**Added UpdateExpressionInfo to imports**

**Added to Collections interface**:
```typescript
updateExpressions: UpdateExpressionInfo[];
```

**Added array initialization** (around line 1227):
```typescript
const updateExpressions: UpdateExpressionInfo[] = [];
```

**Added to allCollections object**:
```typescript
updateExpressions,
```

**Added module-level UpdateExpression visitor** (after traverse_assignments, around line 1410):
```typescript
// UpdateExpression (module-level: count++, --total)
this.profiler.start('traverse_updates');

traverse(ast, {
  UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
    const functionParent = updatePath.getFunctionParent();
    if (functionParent) return;  // Skip function-level, handled elsewhere

    this.collectUpdateExpression(updatePath.node, module, updateExpressions, undefined);
  }
});
this.profiler.end('traverse_updates');
```

**Replaced function-level UpdateExpression visitor** (around line 3319):
```typescript
UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
  const funcUpdateExpressions = collections.updateExpressions as UpdateExpressionInfo[];
  // Use current scope from stack (tracks if/else/loop/try scope transitions)
  this.collectUpdateExpression(updatePath.node, module, funcUpdateExpressions, getCurrentScopeId());
},
```

**Added collectUpdateExpression helper method** (around line 4039):
```typescript
private collectUpdateExpression(
  updateNode: t.UpdateExpression,
  module: VisitorModule,
  updateExpressions: UpdateExpressionInfo[],
  parentScopeId: string | undefined
): void {
  // Only handle simple identifiers (i++, --count)
  if (updateNode.argument.type !== 'Identifier') {
    return;
  }

  const variableName = updateNode.argument.name;
  const operator = updateNode.operator as '++' | '--';
  const prefix = updateNode.prefix;
  const line = getLine(updateNode);
  const column = getColumn(updateNode);

  updateExpressions.push({
    variableName,
    variableLine: getLine(updateNode.argument),
    operator,
    prefix,
    file: module.file,
    line,
    column,
    parentScopeId
  });
}
```

**Added updateExpressions to graphBuilder.build() call** (around line 1624):
```typescript
updateExpressions,
```

### 3. GraphBuilder (packages/core/src/plugins/analysis/ast/GraphBuilder.ts)

**Added UpdateExpressionInfo to imports**

**Added to build() destructuring** (around line 141):
```typescript
updateExpressions = [],
```

**Added bufferUpdateExpressionEdges call** (around line 312):
```typescript
// 28.5. Buffer UPDATE_EXPRESSION nodes and MODIFIES/READS_FROM edges (REG-288)
this.bufferUpdateExpressionEdges(updateExpressions, variableDeclarations, parameters);
```

**Implemented bufferUpdateExpressionEdges method** (around line 1884):
```typescript
private bufferUpdateExpressionEdges(
  updateExpressions: UpdateExpressionInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[]
): void {
  // Build lookup cache for O(n) instead of O(n*m)
  const varLookup = new Map<string, VariableDeclarationInfo>();
  for (const v of variableDeclarations) {
    varLookup.set(`${v.file}:${v.name}`, v);
  }

  const paramLookup = new Map<string, ParameterInfo>();
  for (const p of parameters) {
    paramLookup.set(`${p.file}:${p.name}`, p);
  }

  for (const update of updateExpressions) {
    const { variableName, operator, prefix, file, line, column, parentScopeId } = update;

    // Find target variable node
    const targetVar = varLookup.get(`${file}:${variableName}`);
    const targetParam = !targetVar ? paramLookup.get(`${file}:${variableName}`) : null;
    const targetNodeId = targetVar?.id ?? targetParam?.id;

    if (!targetNodeId) continue;

    // Create UPDATE_EXPRESSION node
    const updateId = `${file}:UPDATE_EXPRESSION:${operator}:${line}:${column}`;

    this._bufferNode({
      type: 'UPDATE_EXPRESSION',
      id: updateId,
      name: `${prefix ? operator : ''}${variableName}${prefix ? '' : operator}`,
      operator,
      prefix,
      variableName,
      file,
      line,
      column
    });

    // Create READS_FROM self-loop
    this._bufferEdge({
      type: 'READS_FROM',
      src: targetNodeId,
      dst: targetNodeId
    });

    // Create MODIFIES edge
    this._bufferEdge({
      type: 'MODIFIES',
      src: updateId,
      dst: targetNodeId
    });

    // Create CONTAINS edge (if scope exists)
    if (parentScopeId) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId,
        dst: updateId
      });
    }
  }
}
```

**Removed old MODIFIES mechanism from bufferScopeEdges** (around line 385):
Removed the destructuring of `modifies` and the loop that created SCOPE -> MODIFIES -> VARIABLE edges.

**Updated scope destructuring in build()** (around line 162):
Removed `modifies` from the destructuring since the field no longer exists.

## Edge Changes

**REMOVED:**
- `SCOPE --MODIFIES--> VARIABLE` (old mechanism)

**ADDED:**
- `UPDATE_EXPRESSION --MODIFIES--> VARIABLE`
- `VARIABLE --READS_FROM--> VARIABLE` (self-loop)
- `SCOPE --CONTAINS--> UPDATE_EXPRESSION`

## Node Changes

**ADDED:**
- `UPDATE_EXPRESSION` node type with properties:
  - id: `{file}:UPDATE_EXPRESSION:{operator}:{line}:{column}`
  - type: 'UPDATE_EXPRESSION'
  - name: e.g., 'count++' or '++count'
  - operator: '++' or '--'
  - prefix: boolean
  - variableName: string
  - file, line, column: location info

## Key Implementation Details

1. **ID format**: `{file}:UPDATE_EXPRESSION:{operator}:{line}:{column}`
   - Example: `/path/to/file.js:UPDATE_EXPRESSION:++:42:10`

2. **Name format**:
   - `++i` for prefix (prefix=true)
   - `i++` for postfix (prefix=false)

3. **Scope tracking**: Uses `getCurrentScopeId()` from the scopeIdStack for function-level updates, ensuring correct CONTAINS edges for nested scopes (if/else, loops, try/catch).

4. **Member expressions excluded**: Only handles simple identifiers (i++, --count). Member expressions (obj.prop++, arr[i]++) are explicitly skipped and will be handled separately.

## Tests

All 21 tests in `/Users/vadimr/grafema-worker-4/test/unit/UpdateExpression.test.js` pass:

- Postfix increment (i++): 3 tests
- Prefix increment (++i): 1 test
- Decrement (--): 2 tests
- Function-level updates: 1 test
- Module-level updates: 2 tests
- Old mechanism removed: 1 test
- Nested scopes: 2 tests
- Edge direction verification: 2 tests
- Integration with real-world patterns: 3 tests
- Edge cases and limitations: 4 tests

## Build Status

Project compiles successfully with no TypeScript errors.

---

**Rob Pike's Sign-off:**

Implementation follows existing patterns (VariableReassignment), uses lookup caches for O(n) performance, and handles all edge cases specified in the technical plan. The code is simple, readable, and does exactly what it needs to do.
