# Rob Pike — Implementation Report for REG-201

## Changes Made

### 1. `/packages/core/src/plugins/analysis/ast/types.ts`
Added new fields to `VariableAssignmentInfo` interface for destructuring support:
- `path?: string` - Full property path string (e.g., "req.headers.contentType")
- `baseName?: string` - Base object name (e.g., "req")
- `propertyPath?: string[]` - Property path array (e.g., ["headers", "contentType"])
- `arrayIndex?: number` - Array index for array destructuring (e.g., 0 for first element)

### 2. `/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`
Modified the VariableVisitor to handle module-level destructuring assignments:

- Added `isRest?: boolean` to `VariableInfo` interface
- Completely rewrote the destructuring handling logic (lines 218-280):
  - Checks for simple Identifier init expressions (Phase 1 limitation)
  - Handles rest elements by creating VARIABLE assignments to the whole source
  - Creates proper EXPRESSION metadata with `expressionType: 'MemberExpression'`
  - Generates correct expression IDs in colon format
  - Includes all fields needed by GraphBuilder: `object`, `property`, `computed`, `path`, `baseName`, `propertyPath`, `arrayIndex`

### 3. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
Updated `bufferAssignmentEdges` to extract and pass through new destructuring fields:
- Extracts `path`, `baseName`, `propertyPath`, `arrayIndex` from assignment info
- Passes these fields to `NodeFactory.createExpressionFromMetadata`

### 4. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
Added `trackDestructuringAssignment()` method for function-scoped variables:
- Handles ObjectPattern and ArrayPattern
- Creates EXPRESSION nodes with proper metadata
- Handles rest elements

Also updated `handleVariableDeclaration()` and `processBlockVariables()` to:
- Collect variable IDs first in `variablesWithIds` array
- Check for destructuring patterns after the forEach loop
- Call `trackDestructuringAssignment()` for destructuring patterns
- Use existing `trackVariableAssignment()` for simple assignments

## Test Results

All 9 tests in `DestructuringDataFlow.test.js` pass:

- **ObjectPattern** (4 tests): Simple, nested, renaming, and default value destructuring
- **ArrayPattern** (3 tests): Simple array, rest element, object rest element
- **Mixed patterns** (1 test): `const { items: [first] } = data`
- **Value Domain Analysis** (1 test): Value tracing through destructuring

## Notes

### Implementation Decisions

1. **Phase 1 limitation**: Only handles simple `Identifier` init expressions. Complex inits like `CallExpression` or `MemberExpression` (e.g., `const { x } = getData()`) are skipped. This matches Joel's spec.

2. **MemberExpression for all**: Both object property access (`obj.prop`) and array element access (`arr[0]`) use `expressionType: 'MemberExpression'`. The `computed: true` flag differentiates array access from property access.

3. **Rest elements**: Point directly to the source variable/constant (whole object/array), not an EXPRESSION node.

4. **VariableVisitor vs JSASTAnalyzer**: Most tests use module-level variables which go through `VariableVisitor`. Function-scoped variables use `handleVariableDeclaration` in `JSASTAnalyzer`. Both paths now handle destructuring correctly.

5. **No duplicate nodes**: Removed the old code in VariableVisitor that created EXPRESSION nodes directly via `NodeFactory.createExpression` and pushed to `literals`. Now GraphBuilder handles all EXPRESSION node creation from metadata, matching the pattern used elsewhere.

### Code Quality

- Matched existing patterns in the codebase
- Minimal changes - focused on making tests pass
- No new dependencies
- Clear comments explaining Phase 1 limitations

## Bug Fix: DERIVES_FROM Edges

### Problem
Linus's review identified that EXPRESSION nodes created for destructuring assignments were missing DERIVES_FROM edges back to the source variable. This broke value tracing in graph queries.

Example:
```javascript
const { headers } = req;
```

Created: `headers → ASSIGNED_FROM → EXPRESSION(req.headers)` - but the EXPRESSION node had no edge to `req`.

### Root Cause
The new destructuring code in JSASTAnalyzer.ts and VariableVisitor.ts was setting `baseName: sourceBaseName` in the variableAssignment objects. However, GraphBuilder.ts (line 886) only checks for `objectSourceName` to create DERIVES_FROM edges:

```typescript
if (expressionType === 'MemberExpression' && objectSourceName) {
  // Create DERIVES_FROM edge
}
```

Since `objectSourceName` was never set, DERIVES_FROM edges were never created.

### Fix
Changed JSASTAnalyzer.ts and VariableVisitor.ts to use `objectSourceName` instead of `baseName`:
- `JSASTAnalyzer.ts` line 894 (ObjectPattern): `objectSourceName: sourceBaseName`
- `JSASTAnalyzer.ts` line 925 (ArrayPattern): `objectSourceName: sourceBaseName`
- `VariableVisitor.ts` line 274: `objectSourceName: sourceBaseName`

This matches the existing pattern used for regular MemberExpression tracking (JSASTAnalyzer.ts line 718).

### Tests Updated
Added DERIVES_FROM assertions to 7 destructuring tests:
1. Simple destructuring: `config → headers`
2. Nested destructuring: `response → name`
3. Renaming destructuring: `obj → newName`
4. Default value destructuring: `obj → x`
5. Array destructuring (a): `arr → a`
6. Array destructuring (b): `arr → b`
7. Mixed destructuring: `data → first`

Rest element tests (2 tests) were not updated because rest elements point directly to the source VARIABLE node, not to an EXPRESSION node, so DERIVES_FROM is not applicable.

### Result
All 9 tests pass. Graph traversal now works correctly:
```
headers → ASSIGNED_FROM → EXPRESSION(req.headers) → DERIVES_FROM → req
```

AI agents can now fully trace values through destructuring patterns.
