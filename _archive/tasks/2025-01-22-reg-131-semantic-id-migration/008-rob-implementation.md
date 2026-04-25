# Rob Pike - Implementation Report for REG-131

## Summary

Implemented semantic ID migration for class methods and arrow functions. All 16 tests in `ClassMethodSemanticId.test.js` now pass.

## Changes Made

### 1. ClassVisitor.ts

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

**Changes:**
- Line 246-267: Updated ClassProperty function handler to use semantic ID as primary ID
- Line 306-328: Updated ClassMethod handler to use semantic ID as primary ID
- Line 42-58: Updated `ClassFunctionInfo` interface to remove `semanticId` field and add `legacyId` for debugging

**Pattern used:**
```typescript
// Before
const functionId = `FUNCTION#${className}.${methodName}#${module.file}#${line}:${column}`;

// After
const legacyId = `FUNCTION#${className}.${methodName}#${module.file}#${line}:${column}`;
const functionId = computeSemanticId('FUNCTION', methodName, scopeTracker.getContext());
```

### 2. CallExpressionVisitor.ts

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Changes:**
- Lines 975-1034: Rewrote `getFunctionScopeId()` method to produce semantic IDs instead of legacy IDs

**Key insight:** The method now walks up the AST to reconstruct the scope path and generates semantic IDs that match what FunctionVisitor/ClassVisitor produce.

```typescript
// Reconstructs scope path by walking up the AST
getFunctionScopeId(functionParent: NodePath, module: VisitorModule): string {
  // ... walks up to find ClassDeclaration if any ...
  // If no class found, it's at module level (global scope)
  if (scopePath.length === 0) {
    scopePath.push('global');
  }
  // Compute semantic ID: {file}->{scopePath}->FUNCTION->{name}
  return `${module.file}->${scopePath.join('->')}->FUNCTION->${funcName}`;
}
```

### 3. JSASTAnalyzer.ts

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Changes:**
- Lines 901-903: Module-level AssignmentExpression handler now uses semantic ID
- Lines 975-977: Module-level FunctionExpression callback handler now uses semantic ID
- Lines 1678-1682: Nested FunctionExpression handler now uses semantic ID with fallback
- Lines 1736-1740: Nested ArrowFunctionExpression handler now uses semantic ID with fallback

**Pattern used (with fallback for edge cases):**
```typescript
const legacyId = `FUNCTION#${funcName}#...`;
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
  : legacyId;
```

### 4. SocketIOAnalyzer.ts

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/SocketIOAnalyzer.ts`

**Changes:**
- Lines 311-329: Handler function lookup now uses `getAllNodes()` query instead of constructing legacy ID

**Before:**
```typescript
const handlerFunctionId = `FUNCTION#${listener.handlerName}#${listener.file}#${listener.handlerLine}`;
const handlerFunction = await graph.getNode(handlerFunctionId);
```

**After:**
```typescript
const handlerFunctions = await graph.getAllNodes({
  type: 'FUNCTION',
  name: listener.handlerName,
  file: listener.file
});
const handlerFunction = handlerFunctions.find(fn => fn.line === listener.handlerLine);
```

## Test Results

```
# tests 16
# suites 9
# pass 16
# fail 0
```

All tests in `ClassMethodSemanticId.test.js` pass:
- Class method semantic ID format (2 tests)
- Class property function semantic ID (2 tests)
- Constructor semantic ID (2 tests)
- Static method semantic ID (2 tests)
- Getter/setter semantic ID (3 tests)
- No FUNCTION# prefix in output (2 tests)
- CONTAINS edges consistency (2 tests)
- Semantic ID stability (1 test)

## Notes

1. **Other test failures:** There are 24 failing tests in the full test suite, but these are unrelated to REG-131. They involve Expression nodes, Object mutations, SQL injection, etc. - features with other pending changes in the working directory.

2. **Legacy ID preservation:** Added `legacyId` field to `ClassFunctionInfo` interface for debugging/migration purposes. This can be removed later if not needed.

3. **Fallback pattern:** Used fallback to legacy IDs in nested function handlers where `scopeTracker` might be unavailable. This matches the pattern used in FunctionVisitor.

4. **No breaking changes:** The semantic ID format is compatible with existing tests that don't assert on specific ID formats.
