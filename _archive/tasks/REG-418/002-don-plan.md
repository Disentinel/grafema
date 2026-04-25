# Don Melton - REG-418 Analysis & Plan

## Problem Statement

`trackVariableAssignment()` in `JSASTAnalyzer.ts` (line 674-727) creates an **inline CALL node** when a variable is initialized from a member expression call (e.g., `const valid = data.filter(fn)`). The same call site also gets a **standard CALL node** from either `CallExpressionVisitor` (module-level) or `handleCallExpression` (inside function bodies). Result: two CALL nodes for one call site.

## What Each Path Creates

### Standard Path (CallExpressionVisitor / handleCallExpression)

**Node created:** Pushed to `methodCalls` collection, buffered by `bufferMethodCalls()` (GraphBuilder.ts:998).

| Field | Value |
|-------|-------|
| `id` | Semantic ID: `file->scope->CALL->obj.method#0` |
| `type` | `'CALL'` |
| `name` | `obj.method` |
| `object` | `obj` |
| `method` | `method` |
| `parentScopeId` | Enclosing scope ID |
| `computed` | boolean |
| `computedPropertyVar` | variable name for `obj[x]()` |
| `grafemaIgnore` | REG-332 annotation if present |
| `isAwaited` | REG-297: true if `await obj.method()` |
| `isInsideTry` | REG-311: true if inside try block |

**Edges created:**
1. `CONTAINS` -- scope -> CALL node (GraphBuilder.ts:1008)
2. `USES` -- CALL node -> receiver variable (GraphBuilder.ts:1028, REG-262)
3. `PASSES_ARGUMENT` edges for each argument (via `extractArguments`/`extractMethodCallArguments`)
4. `HAS_CALLBACK` edges for callback arguments

### Inline Path (trackVariableAssignment, line 674-727)

**Node created:** Pushed to `literals` collection, buffered by `bufferLiterals()` (GraphBuilder.ts:1535).

| Field | Value |
|-------|-------|
| `id` | Legacy format: `CALL#obj.method#file#line:col:inline` |
| `type` | `'CALL'` |
| `name` | `obj.method` |
| `object` | `objectName` |
| `method` | `methodName` |
| `file` | file path |
| `arguments` | Array of extracted literal argument values |
| `line` | line number |
| `column` | column number |

**Edges created:**
1. `ASSIGNED_FROM` -- variable -> inline CALL node (via `variableAssignment` with `sourceType: 'CALL'`, `sourceId: methodCallId`)

**Additional literal nodes:** For each argument with a literal value, a `LITERAL` node with `parentCallId: methodCallId` is created.

### Comparison: What Inline Has That Standard Doesn't

| Capability | Inline | Standard |
|-----------|--------|----------|
| `arguments` field (literal values on node) | Yes | No (uses separate PASSES_ARGUMENT edges + LITERAL nodes) |
| `parentScopeId` | No | Yes |
| `CONTAINS` edge from scope | No | Yes |
| `USES` edge to receiver variable | No | Yes |
| `PASSES_ARGUMENT` edges | No (only creates LITERAL nodes with parentCallId) | Yes |
| `grafemaIgnore` annotation | No | Yes |
| `isAwaited` flag | No | Yes |
| `computed` / `computedPropertyVar` | No | Yes |
| `ASSIGNED_FROM` from variable | Yes (direct) | No (not created by standard path) |

**Key insight:** The inline path provides ONE thing the standard path doesn't: the `ASSIGNED_FROM` edge from the variable to the CALL node. But it does this by creating a redundant CALL node rather than referencing the standard one.

## What Depends on the Inline ID Format

Searched for `:inline"` pattern across the codebase:
- **Only one location:** `JSASTAnalyzer.ts:681` (the creation site itself)
- **No queries, enrichers, or downstream code** depends on the `:inline` suffix
- **No tests** assert on the specific inline ID format -- the test at `DestructuringDataFlow.test.js:720` only checks `node.type === 'CALL'` and `name.includes('filter')`

The `arguments` field stored on the inline CALL node is also not consumed by any downstream code. It was likely added for debugging or future use but nothing reads it.

## Recommended Fix

**Replace the inline CALL node creation with a coordinate-based lookup**, matching the pattern already used by:
- `detectVariableReassignment()` which uses `sourceType: 'METHOD_CALL'` with coordinates (line 5959)
- `trackDestructuringAssignment()` which uses `callSourceLine`/`callSourceColumn` for DERIVES_FROM edges (line 1291)

### Specific Changes

**In `trackVariableAssignment()` (JSASTAnalyzer.ts, lines 674-727):**

Replace the entire "case 3: MemberExpression call" block:

**Before:**
```typescript
// 3. MemberExpression call (e.g., arr.map())
if (initExpression.type === 'CallExpression' && initExpression.callee.type === 'MemberExpression') {
  // ... creates inline CALL node in literals array
  // ... creates variableAssignment with sourceType: 'CALL', sourceId: inlineId
}
```

**After:**
```typescript
// 3. MemberExpression call (e.g., arr.map())
if (initExpression.type === 'CallExpression' && initExpression.callee.type === 'MemberExpression') {
  variableAssignments.push({
    variableId,
    sourceType: 'METHOD_CALL',
    sourceLine: getLine(initExpression),
    sourceColumn: getColumn(initExpression),
    sourceFile: module.file,
    line: line
  });
  return;
}
```

This delegates the ASSIGNED_FROM edge creation to `bufferAssignmentEdges()` in GraphBuilder.ts (line 1603), which already handles `sourceType: 'METHOD_CALL'` by looking up the standard CALL node by coordinates.

**No changes needed in GraphBuilder.ts** -- the `METHOD_CALL` sourceType handler at line 1603 already does the right thing.

### What About the Literal Argument Nodes?

The inline path also creates LITERAL nodes for call arguments with `parentCallId` pointing to the inline CALL ID. These LITERAL nodes are orphaned when the inline CALL is removed. However:

1. The standard path (via `CallExpressionVisitor.extractArguments` or `handleCallExpression.extractMethodCallArguments`) already creates proper LITERAL nodes and PASSES_ARGUMENT edges for the same arguments
2. The inline-created LITERAL nodes use different IDs (based on the inline CALL ID), creating duplicates
3. Removing them is correct

## Risk Assessment

**Risk: LOW**

1. **No downstream consumers** of inline CALL IDs -- verified by codebase search
2. **Standard CALL nodes already exist** for every call site where inline nodes are created
3. **The `METHOD_CALL` sourceType handler already works** -- used by `detectVariableReassignment` for the same pattern
4. **Existing tests pass with either CALL node** -- assertions check `type` and `name`, not specific IDs
5. **Pattern is already established** -- `CALL_SITE` (for `const x = fn()`) and `METHOD_CALL` (for reassignments) both use coordinate-based lookup

**One thing to verify in tests:** The DestructuringDataFlow test at line 720 says "DERIVES_FROM should point to inline CALL node" but actually uses coordinate-based lookup (already correct). The comment should be updated.

## Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Replace inline CALL creation with `METHOD_CALL` sourceType + coordinates | 674-727 |
| `test/unit/DestructuringDataFlow.test.js` | Update comment "inline CALL node" -> "CALL node" | 720 |

**No other files need changes.** GraphBuilder.ts already handles `METHOD_CALL` sourceType correctly.

## Verification Plan

1. Run existing tests that cover variable-to-method-call assignment:
   - `test/unit/DestructuringDataFlow.test.js` (Method Call section)
   - `test/unit/ObjectLiteralAssignment.test.js`
   - `test/unit/reg327-local-vars.test.js`
2. Verify no duplicate CALL nodes exist for `const x = obj.method()` patterns
3. Verify ASSIGNED_FROM edge from variable points to the standard CALL node
4. Run full test suite before final commit
