# Joel Spolsky — Technical Specification for REG-201

## Summary

Implement ASSIGNED_FROM edges for destructuring assignments by creating a new `trackDestructuringAssignment()` method that preserves metadata from `extractVariableNamesFromPattern()` and emits proper EXPRESSION nodes. The existing infrastructure (ExtractedVariable metadata, GraphBuilder EXPRESSION handling) already supports this - we just need to connect the dots.

**Core Insight**: Don is correct - 80% exists. `extractVariableNamesFromPattern()` gives us `propertyPath` and `arrayIndex`. We need to use this metadata to emit EXPRESSION nodes representing `source.property` or `source[index]` instead of just `source`.

## Files to Modify

### Primary File
- `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

### Call Sites (2 locations)
1. Line 1346: `handleVariableDeclaration()`
2. Line 1445: `processBlockVariables()`

## Implementation Steps

### Step 1: Create `trackDestructuringAssignment()` Method

**Location**: `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Insert after**: Line 723 (after `trackVariableAssignment()` ends)

**Method signature**:
```typescript
/**
 * Tracks destructuring assignments for data flow analysis
 *
 * For ObjectPattern: creates EXPRESSION nodes representing source.property
 * For ArrayPattern: creates EXPRESSION nodes representing source[index]
 *
 * Phase 1 limitation: Only handles simple Identifier init expressions.
 * Complex init (CallExpression, MemberExpression) will be logged and skipped.
 *
 * @param pattern - The destructuring pattern (ObjectPattern or ArrayPattern)
 * @param initNode - The init expression (right-hand side)
 * @param variables - Extracted variables with propertyPath/arrayIndex metadata
 * @param module - Module context
 * @param variableAssignments - Collection to push assignment info to
 */
private trackDestructuringAssignment(
  pattern: t.ObjectPattern | t.ArrayPattern,
  initNode: t.Expression | null | undefined,
  variables: ExtractedVariable[],
  module: VisitorModule,
  variableAssignments: VariableAssignmentInfo[]
): void
```

**Implementation logic**:

```typescript
private trackDestructuringAssignment(
  pattern: t.ObjectPattern | t.ArrayPattern,
  initNode: t.Expression | null | undefined,
  variables: ExtractedVariable[],
  module: VisitorModule,
  variableAssignments: VariableAssignmentInfo[]
): void {
  if (!initNode) return;

  // Phase 1: Only handle simple Identifier init expressions
  // Examples: const { x } = obj, const [a] = arr
  if (!t.isIdentifier(initNode)) {
    // TODO: Phase 2 - handle CallExpression, MemberExpression, etc.
    console.warn(`[trackDestructuringAssignment] Skipping complex init expression type: ${initNode.type} at ${module.file}:${initNode.loc?.start.line || '?'}`);
    return;
  }

  const sourceBaseName = initNode.name;
  const baseLine = initNode.loc?.start.line || 0;
  const baseColumn = initNode.start ?? 0;

  // Process each extracted variable
  for (const varInfo of variables) {
    const variableId = varInfo.id; // ID was already assigned in call site

    // Handle rest elements specially
    if (varInfo.isRest) {
      // For rest elements (const { x, ...rest } = obj),
      // create edge to the whole source object (imprecise but not wrong)
      variableAssignments.push({
        variableId,
        sourceType: 'VARIABLE',
        sourceName: sourceBaseName,
        line: varInfo.loc.start.line
      });
      continue;
    }

    // ObjectPattern: const { headers } = req → headers ASSIGNED_FROM req.headers
    if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
      const propertyPath = varInfo.propertyPath;
      const expressionLine = varInfo.loc.start.line;
      const expressionColumn = varInfo.loc.start.column;

      // Build property path string (e.g., "req.headers.contentType" for nested)
      const fullPath = [sourceBaseName, ...propertyPath].join('.');

      // For simple cases: object.property
      // For nested: object.prop1.prop2.prop3
      const expressionId = ExpressionNode.generateId(
        'MemberExpression',
        module.file,
        expressionLine,
        expressionColumn
      );

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'MemberExpression',
        object: sourceBaseName,
        property: propertyPath[0], // First property for simple display
        computed: false,
        path: fullPath, // Full path for nested cases
        baseName: sourceBaseName,
        propertyPath: propertyPath, // Full property path array
        file: module.file,
        line: expressionLine,
        column: expressionColumn
      });
    }
    // ArrayPattern: const [first, second] = arr → first ASSIGNED_FROM arr[0]
    else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
      const arrayIndex = varInfo.arrayIndex;
      const expressionLine = varInfo.loc.start.line;
      const expressionColumn = varInfo.loc.start.column;

      const expressionId = ExpressionNode.generateId(
        'MemberExpression',
        module.file,
        expressionLine,
        expressionColumn
      );

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'MemberExpression',
        object: sourceBaseName,
        property: String(arrayIndex), // "0", "1", "2", etc.
        computed: true, // Array access is computed
        baseName: sourceBaseName,
        arrayIndex: arrayIndex, // Preserve numeric index
        file: module.file,
        line: expressionLine,
        column: expressionColumn
      });
    }
    // No metadata (shouldn't happen with extractVariableNamesFromPattern)
    else {
      console.warn(`[trackDestructuringAssignment] Variable ${varInfo.name} has no propertyPath or arrayIndex metadata`);
    }
  }
}
```

**Key decisions explained**:

1. **Phase 1 limitation**: Only `t.isIdentifier(initNode)` - handles 80% of real-world cases, keeps implementation simple
2. **Rest elements**: Create edge to whole source object (not wrong, just imprecise)
3. **Nested destructuring**: Use `path` field with full dotted string AND `propertyPath` array - supports both display and analysis
4. **Array destructuring**: Use `computed: true` + `arrayIndex` field
5. **ID generation**: Use `ExpressionNode.generateId()` (existing utility, lines 146-153)
6. **GraphBuilder compatibility**: Emit exact same structure as existing MemberExpression tracking (line 709-722)

### Step 2: Modify Call Site in `handleVariableDeclaration()`

**Location**: Line 1345-1348 in `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Current code**:
```typescript
if (declarator.init) {
  this.trackVariableAssignment(declarator.init, varId, varInfo.name, module, varInfo.loc.start.line, literals, variableAssignments, literalCounterRef);
}
```

**New code**:
```typescript
if (declarator.init) {
  // Check if this is destructuring pattern
  if (t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)) {
    // Use specialized destructuring tracking
    this.trackDestructuringAssignment(
      declarator.id,
      declarator.init,
      variables,
      module,
      variableAssignments
    );
  } else {
    // Use regular variable assignment tracking
    this.trackVariableAssignment(
      declarator.init,
      varId,
      varInfo.name,
      module,
      varInfo.loc.start.line,
      literals,
      variableAssignments,
      literalCounterRef
    );
  }
}
```

**Critical note**: Need to add `variableId` to `ExtractedVariable` before this point, OR pass `varId` differently. Let me check the flow...

Actually, looking at the code flow more carefully:

1. Line 1284: `const variables = this.extractVariableNamesFromPattern(declarator.id);`
2. Line 1286: `variables.forEach(varInfo => {`
3. Line 1297-1299: `const varId = scopeTracker ? computeSemanticId(...) : legacyId;`
4. Line 1346: `this.trackVariableAssignment(..., varId, ...)`

So `varId` is computed INSIDE the forEach loop. We need to pass it along.

**Better approach**: Enhance `ExtractedVariable` to carry the `id` field temporarily, OR pass a Map.

**Actually simplest**: Pass the whole `variables` array where each entry already went through the loop and has its ID assigned... but we can't modify ExtractedVariable type since it's used in other places.

**Correct solution**: Pass both `variables` array AND a map of `variableName -> variableId`:

```typescript
if (declarator.init) {
  // Check if this is destructuring pattern
  if (t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)) {
    // Build map of variable names to IDs for this declarator
    const variableIdMap = new Map<string, string>();
    variables.forEach(v => {
      // Recompute ID the same way (or better: store during first loop)
      const legacyId = `${nodeType}#${v.name}#${module.file}#${v.loc.start.line}:${v.loc.start.column}:${varDeclCounterRef.value++}`;
      const computedId = scopeTracker
        ? computeSemanticId(nodeType, v.name, scopeTracker.getContext())
        : legacyId;
      variableIdMap.set(v.name, computedId);
    });

    // WAIT - this duplicates the ID generation and increments counter twice!
  }
}
```

This is getting messy. Let me re-examine the structure...

**Actually, better approach**: Restructure to extract variables first, THEN process assignments separately:

Wait, looking more carefully at line 1286: we're in a `forEach` loop over `variables`. Each iteration processes ONE variable. But `trackDestructuringAssignment` needs ALL variables at once (because they share one `declarator.init`).

**Correct solution**: Move assignment tracking OUTSIDE the forEach loop:

**Location**: Lines 1283-1349 need restructuring

**Current structure**:
```typescript
varNode.declarations.forEach(declarator => {
  const variables = this.extractVariableNamesFromPattern(declarator.id);

  variables.forEach(varInfo => {
    // Create variable node
    // ...
    const varId = ...;

    // Track assignment for THIS variable
    if (declarator.init) {
      this.trackVariableAssignment(...);
    }
  });
});
```

**New structure**:
```typescript
varNode.declarations.forEach(declarator => {
  const variables = this.extractVariableNamesFromPattern(declarator.id);
  const variableIds: string[] = []; // Track IDs for later

  variables.forEach(varInfo => {
    // Create variable node
    // ...
    const varId = ...;
    variableIds.push(varId);

    // DON'T track assignment here anymore for destructuring
  });

  // After all variables are created, track assignments
  if (declarator.init) {
    if (t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)) {
      // Enhance variables with their IDs
      const varsWithIds = variables.map((v, i) => ({ ...v, id: variableIds[i] }));
      this.trackDestructuringAssignment(
        declarator.id,
        declarator.init,
        varsWithIds,
        module,
        variableAssignments
      );
    } else {
      // Simple assignment - only one variable
      const varId = variableIds[0];
      const varInfo = variables[0];
      this.trackVariableAssignment(
        declarator.init,
        varId,
        varInfo.name,
        module,
        varInfo.loc.start.line,
        literals,
        variableAssignments,
        literalCounterRef
      );
    }
  }
});
```

This is cleaner. Let me update the spec.

### Step 2 (Revised): Restructure `handleVariableDeclaration()`

**Location**: Lines 1283-1349 in `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Change**: Move assignment tracking outside the `variables.forEach()` loop, after all variable nodes are created.

**Detailed changes**:

1. Line 1283-1286: No change (extract variables)
2. Line 1286-1343: Add array to collect variable IDs:
   ```typescript
   const variableIds: string[] = [];
   variables.forEach(varInfo => {
   ```
3. Inside forEach loop, after creating variable node (line ~1342):
   ```typescript
   variableIds.push(varId);
   ```
4. REMOVE lines 1345-1348 (old assignment tracking inside forEach)
5. After forEach closes (new line ~1344), add:
   ```typescript
   // Track assignments after all variables are created
   if (declarator.init) {
     if (t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)) {
       // Destructuring: pass all variables with their IDs
       const varsWithIds = variables.map((v, i) => ({ ...v, id: variableIds[i] }));
       this.trackDestructuringAssignment(
         declarator.id,
         declarator.init,
         varsWithIds,
         module,
         variableAssignments
       );
     } else {
       // Simple assignment: use existing tracking
       this.trackVariableAssignment(
         declarator.init,
         variableIds[0],
         variables[0].name,
         module,
         variables[0].loc.start.line,
         literals,
         variableAssignments,
         literalCounterRef
       );
     }
   }
   ```

### Step 3: Modify Call Site in `processBlockVariables()`

**Location**: Lines 1420-1447 in `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Apply same restructuring as Step 2**:

1. Line 1420-1423: Extract variables (no change)
2. Line 1423-1442: Add `const variableIds: string[] = [];` and collect IDs
3. Line 1435: Push to variableIds: `variableIds.push(varId);`
4. REMOVE lines 1444-1446 (old assignment tracking)
5. After forEach (new line ~1443), add same conditional logic as Step 2

### Step 4: Update TypeScript Interface for ExtractedVariable (optional enhancement)

**Location**: `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/types.ts` line 553

**Current**:
```typescript
export interface ExtractedVariable {
  name: string;
  loc: { start: { line: number; column: number } };
  propertyPath?: string[];
  arrayIndex?: number;
  isRest?: boolean;
}
```

**Add optional field**:
```typescript
export interface ExtractedVariable {
  name: string;
  loc: { start: { line: number; column: number } };
  propertyPath?: string[];
  arrayIndex?: number;
  isRest?: boolean;
  id?: string; // Populated during assignment tracking phase
}
```

This makes the `varsWithIds` mapping type-safe.

## Test Plan

All tests already exist in `/Users/vadimr/grafema-worker-4/test/unit/DestructuringDataFlow.test.js`

### Test Cases (Kent should verify these pass)

**ObjectPattern tests**:
1. ✅ Simple destructuring: `const { method } = config`
   - Test: lines 45-92
   - Should create: `method ASSIGNED_FROM EXPRESSION(config.method)`

2. ✅ Nested destructuring: `const { data: { user: { name } } } = response`
   - Test: lines 94-131
   - Should create: `name ASSIGNED_FROM EXPRESSION(response.data.user.name)`

3. ✅ Renaming: `const { oldName: newName } = obj`
   - Test: lines 133-169
   - Should create: `newName ASSIGNED_FROM EXPRESSION(obj.oldName)`

**ArrayPattern tests**:
4. ✅ Array destructuring: `const [a, b] = arr`
   - Test: lines 173-209
   - Should create: `a ASSIGNED_FROM EXPRESSION(arr[0])`, `b ASSIGNED_FROM EXPRESSION(arr[1])`

5. ✅ Rest element: `const [first, ...rest] = arr`
   - Test: lines 211-248
   - Should create: `rest ASSIGNED_FROM arr` (whole array, not specific index)

**Integration test**:
6. ✅ Value domain analysis: `obj[method]()` should resolve via destructuring
   - Test: lines 251-286
   - Requires ValueDomainAnalyzer to trace through ASSIGNED_FROM edges

### Edge Cases to Test

Kent should add these tests:

7. **Default values**: `const { x = 5 } = obj`
   - Should create: `x ASSIGNED_FROM EXPRESSION(obj.x)`
   - AssignmentPattern is already handled by extractVariableNamesFromPattern

8. **Mixed destructuring**: `const { a, b: [c, d] } = obj`
   - Phase 1: Should log warning and skip (complex nested pattern)
   - Phase 2: Should handle properly

9. **Complex init expression** (Phase 1 should skip with warning):
   - `const { headers } = getRequest()`
   - `const { x } = obj.nested.prop`
   - Should log: "Skipping complex init expression type: CallExpression"

### Regression Tests

10. **Simple assignments still work**:
    - `const x = 5` → ASSIGNED_FROM LITERAL
    - `const y = someVar` → ASSIGNED_FROM VARIABLE
    - `const z = foo()` → ASSIGNED_FROM CALL

## Acceptance Criteria

Phase 1 (This Implementation):

- [ ] `const { headers } = req` creates `headers ASSIGNED_FROM EXPRESSION(req.headers)` edge
- [ ] `const [first, second] = arr` creates proper EXPRESSION nodes for `arr[0]`, `arr[1]`
- [ ] Nested object destructuring works: `const { a: { b } } = obj` → `b ASSIGNED_FROM EXPRESSION(obj.a.b)`
- [ ] Renaming works: `const { old: new } = obj` → `new ASSIGNED_FROM EXPRESSION(obj.old)`
- [ ] Rest elements create edge to whole source: `const { x, ...rest } = obj` → `rest ASSIGNED_FROM obj`
- [ ] All existing tests in DestructuringDataFlow.test.js pass
- [ ] No regressions: existing simple assignments still work
- [ ] Complex init expressions log warning and are skipped (not crash)

## Out of Scope (Phase 2)

These are explicitly NOT included in Phase 1:

1. **Complex init expressions**:
   - `const { headers } = getRequest()` - CallExpression init
   - `const { x } = obj.nested` - MemberExpression init
   - `const { y } = arr[0]` - Computed MemberExpression init

2. **Function parameter destructuring**:
   - `function foo({ headers }) { ... }`
   - `const handler = ({ req, res }) => { ... }`
   - This requires changes to function parameter handling (separate visitor)

3. **Destructuring in other contexts**:
   - `for (const { key, value } of entries) { ... }`
   - `catch ({ message }) { ... }`
   - May already work if `processBlockVariables` handles them

4. **Advanced rest element semantics**:
   - Currently: `const { x, ...rest } = obj` → `rest ASSIGNED_FROM obj` (imprecise)
   - Future: Create special "object minus x" EXPRESSION node
   - Requires ValueDomainAnalyzer enhancement

## Risk Mitigation

### Risk 1: Breaking Existing Assignment Tracking

**Mitigation**:
- Step 2/3 explicitly checks pattern type before calling new method
- Non-destructuring declarations use existing `trackVariableAssignment`
- Kent should run full test suite, not just new tests

### Risk 2: ID Counter Duplication

**Issue**: Moving assignment tracking outside forEach means we need variable IDs but counter already incremented

**Solution**: Collect IDs in array during forEach, use them after. No duplicate ID generation.

### Risk 3: GraphBuilder Doesn't Handle New EXPRESSION Nodes

**Mitigation**:
- GraphBuilder already handles EXPRESSION with propertyPath/arrayIndex (lines 830-898)
- ExpressionNode.create() already accepts these fields (lines 94-95)
- We're using existing patterns, not inventing new ones

### Risk 4: ValueDomainAnalyzer Can't Trace New Edges

**Assessment**:
- ValueDomainAnalyzer uses AliasTracker which follows ASSIGNED_FROM edges (lines 268-274 per Don's analysis)
- Should work automatically
- Test #6 (lines 251-286) validates this integration

## Implementation Order

1. **Kent**: Add edge case tests (#7-9) to DestructuringDataFlow.test.js
2. **Rob**: Implement Step 1 (new method `trackDestructuringAssignment`)
3. **Rob**: Implement Step 2 (modify `handleVariableDeclaration`)
4. **Rob**: Implement Step 3 (modify `processBlockVariables`)
5. **Rob**: Optional Step 4 (update TypeScript interface)
6. **Kent**: Run all tests (existing + new)
7. **Rob**: Fix any issues
8. **Kevlin + Linus**: Review

## Open Questions

1. **Should we handle function parameter destructuring in Phase 1?**
   - My recommendation: NO. Keep scope minimal. Separate issue.
   - Function parameters go through different visitor path

2. **What about computed property names in destructuring?**
   ```javascript
   const key = 'headers';
   const { [key]: value } = req; // value = req.headers
   ```
   - My recommendation: Phase 2. Rare pattern, adds complexity.

3. **Should rest elements get special EXPRESSION type?**
   - Current: `rest ASSIGNED_FROM obj` (sourceType: VARIABLE)
   - Alternative: Create EXPRESSION type "ObjectRest" or "ArrayRest"
   - My recommendation: Use VARIABLE for Phase 1, document as "imprecise but not wrong"

## Notes for Rob

- Import statement for Babel types already exists: `import * as t from '@babel/types';`
- ExpressionNode is already imported (check top of file)
- getLine() and getColumn() utilities already exist (used throughout file)
- Console.warn is fine for Phase 1 - replace with proper logger in Phase 2
- The propertyPath array in EXPRESSION nodes is used by ValueDomainAnalyzer for deep tracing
- Make sure to test with both legacy IDs (no scopeTracker) and semantic IDs (with scopeTracker)

## Success Metrics

After implementation:
1. Run `node --test test/unit/DestructuringDataFlow.test.js` - all tests pass
2. Run full test suite - no regressions
3. Query graph for `const { headers } = req` - should find EXPRESSION node
4. ValueDomainAnalyzer should resolve `obj[method]()` in test #6

## Alignment with Vision

This directly supports "AI should query the graph, not read code":

- **Before**: AI must read `const { headers } = req` source code to understand data flow
- **After**: AI queries graph: `headers -> ASSIGNED_FROM -> EXPRESSION(req.headers)`

Destructuring is ~30-40% of modern JavaScript. This isn't a feature - it's **data integrity**.
