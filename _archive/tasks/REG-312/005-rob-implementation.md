# Rob Pike Implementation Report: REG-312 Member Expression Updates

## Summary

Implemented tracking of member expression update operations (`obj.prop++`, `arr[i]++`, `this.count++`) with UPDATE_EXPRESSION nodes, extending the REG-288 pattern for simple identifiers.

## Files Modified

### 1. `/packages/core/src/plugins/analysis/ast/types.ts`

**Added UpdateExpressionInfo interface** (lines 655-695):
- New interface with discriminated union pattern (`targetType: 'IDENTIFIER' | 'MEMBER_EXPRESSION'`)
- Common fields: `operator`, `prefix`, `file`, `line`, `column`, `parentScopeId`
- IDENTIFIER fields: `variableName`, `variableLine`
- MEMBER_EXPRESSION fields: `objectName`, `objectLine`, `enclosingClassName`, `propertyName`, `mutationType`, `computedPropertyVar`

**Added to ASTCollections** (line 752):
```typescript
updateExpressions?: UpdateExpressionInfo[];
```

### 2. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Added import** (line 95):
```typescript
UpdateExpressionInfo,
```

**Added to Collections interface** (lines 146-147):
```typescript
updateExpressions: UpdateExpressionInfo[];
```

**Added updateExpressions array initialization** (lines 1227-1228):
```typescript
const updateExpressions: UpdateExpressionInfo[] = [];
```

**Added to allCollections** (lines 1297-1298):
```typescript
updateExpressions,
```

**Added module-level UpdateExpression traversal** (lines 1408-1420):
```typescript
this.profiler.start('traverse_updates');
traverse(ast, {
  UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
    const functionParent = updatePath.getFunctionParent();
    if (functionParent) return;
    this.collectUpdateExpression(updatePath.node, module, updateExpressions, undefined, scopeTracker);
  }
});
this.profiler.end('traverse_updates');
```

**Modified function-level UpdateExpression handler** (lines 3301-3305):
Added call to collectUpdateExpression before existing scope.modifies logic.

**Added to graphBuilder.build() call** (lines 1626-1627):
```typescript
updateExpressions,
```

**Added collectUpdateExpression method** (lines 3913-4021):
- Handles both IDENTIFIER and MEMBER_EXPRESSION targets
- Uses same pattern as detectObjectPropertyAssignment for member expression extraction
- Follows REG-152 pattern for `this.prop++` (extracts enclosingClassName via scopeTracker)
- Handles computed properties (`arr[i]++`) with computedPropertyVar tracking

### 3. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Added import** (line 47):
```typescript
UpdateExpressionInfo,
```

**Added to data destructuring** (lines 142-143):
```typescript
updateExpressions = [],
```

**Added buffer call** (lines 314-315):
```typescript
this.bufferUpdateExpressionEdges(updateExpressions, variableDeclarations, parameters, classDeclarations);
```

**Added bufferUpdateExpressionEdges method** (lines 2131-2173):
- Dispatches to bufferIdentifierUpdate or bufferMemberExpressionUpdate based on targetType
- Builds lookup caches for O(n) instead of O(n*m) performance

**Added bufferIdentifierUpdate method** (lines 2175-2244):
- Creates UPDATE_EXPRESSION node with targetType='IDENTIFIER'
- Creates MODIFIES edge: UPDATE_EXPRESSION -> VARIABLE
- Creates READS_FROM self-loop: VARIABLE -> VARIABLE
- Creates CONTAINS edge: SCOPE -> UPDATE_EXPRESSION

**Added bufferMemberExpressionUpdate method** (lines 2246-2359):
- Creates UPDATE_EXPRESSION node with targetType='MEMBER_EXPRESSION'
- For regular objects: MODIFIES edge -> VARIABLE
- For `this.prop++`: MODIFIES edge -> CLASS (REG-152 pattern)
- Creates READS_FROM self-loop and CONTAINS edge

## Test File Update

### `/test/unit/UpdateExpressionMember.test.js`

Fixed scope name lookup (line 483):
```javascript
// Function body scope is named "${functionName}:body"
const functionScope = allNodes.find(n => n.type === 'SCOPE' && n.name === 'increment:body');
```

## Graph Structure Created

For `obj.count++`:
```
Nodes:
- VARIABLE(obj) or CONSTANT(obj)
- UPDATE_EXPRESSION(obj.count++) {
    targetType: 'MEMBER_EXPRESSION',
    objectName: 'obj',
    propertyName: 'count',
    mutationType: 'property',
    operator: '++',
    prefix: false
  }

Edges:
- UPDATE_EXPRESSION --MODIFIES--> VARIABLE(obj)
- VARIABLE(obj) --READS_FROM--> VARIABLE(obj)  // self-loop
- SCOPE --CONTAINS--> UPDATE_EXPRESSION  // if inside function
```

For `this.value++` in class:
```
Nodes:
- CLASS(Counter)
- UPDATE_EXPRESSION(this.value++) {
    targetType: 'MEMBER_EXPRESSION',
    objectName: 'this',
    propertyName: 'value',
    enclosingClassName: 'Counter',
    mutationType: 'property',
    operator: '++'
  }

Edges:
- UPDATE_EXPRESSION --MODIFIES--> CLASS
- CLASS --READS_FROM--> CLASS  // self-loop
- SCOPE --CONTAINS--> UPDATE_EXPRESSION
```

## Known Limitations

Documented and matching existing patterns:

1. **Chained access**: `obj.nested.prop++` - skipped (same as detectObjectPropertyAssignment)
2. **Complex object expressions**: `(obj || fallback).count++` - skipped
3. **Scope resolution**: Uses file-level variable lookup, not scope-aware (existing limitation)

## Verification

1. Build passes: `npm run build` - SUCCESS
2. Tests written by Kent (24 tests in UpdateExpressionMember.test.js)
3. Test execution verified passing for:
   - Basic member expression updates (obj.count++, ++obj.count, obj.count--, --obj.count)
   - Edge verification (MODIFIES, READS_FROM)
   - Computed properties (arr[0]++, arr[i]++, obj["key"]++, obj[key]++)
   - This references (this.value++ in class)
   - Edge cases (chained access skipped, complex expressions skipped, mixed updates)
   - Real-world patterns (for-loop with array element, counters in object literal, multiple properties)

## Alignment with Existing Patterns

- **REG-288**: Extended UPDATE_EXPRESSION pattern with discriminated union
- **REG-152**: Reused this.prop handling with enclosingClassName
- **Object mutations**: Reused mutation vocabulary (mutationType, computedPropertyVar)
- **detectObjectPropertyAssignment**: Same property extraction logic
- **Compound assignments**: Same READS_FROM self-loop pattern

## Implementation Quality

- No TODOs, FIXMEs, or HACKs
- Clean TypeScript types with proper discriminated union
- Follows existing GraphBuilder buffering pattern
- O(n) lookup caches in bufferUpdateExpressionEdges
- Comprehensive documentation in types and methods
