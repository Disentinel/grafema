# Don Melton's Analysis: REG-400 - Callback-as-argument Function References Not Resolved to CALLS Edges

## 1. CURRENT ARCHITECTURE

### Analysis Phase (CallExpressionVisitor.ts)

When `CallExpressionVisitor.extractArguments()` processes function arguments:

1. **Identifier Arguments (line 410-413)**:
   - Type: `Identifier` (e.g., `invokeCleanup` in `forEach(invokeCleanup)`)
   - Action: Records `targetType = 'VARIABLE'` and `targetName = 'invokeCleanup'`
   - Creates: `ArgumentInfo` object with this metadata
   - Result: PASSES_ARGUMENT edge will link to a VARIABLE node (not FUNCTION)

2. **Arrow/Function Expression Arguments (line 414-419)**:
   - Type: `ArrowFunctionExpression | FunctionExpression` (inline callbacks)
   - Action: Records `targetType = 'FUNCTION'` with `functionLine` and `functionColumn`
   - Result: Links directly to FUNCTION node via GraphBuilder.bufferArgumentEdges()

3. **Other Argument Types (CALL, EXPRESSION, OBJECT_LITERAL, etc.)**:
   - Each has specific handling but none handle "identifier referencing a function"

### Graph Building Phase (GraphBuilder.ts - bufferArgumentEdges method)

For each CallArgumentInfo:
- IF targetType === 'VARIABLE': Find VARIABLE node by name in same file → Create PASSES_ARGUMENT -> VARIABLE (not FUNCTION!)
- ELSE IF targetType === 'FUNCTION': Find FUNCTION node by line/column → Create PASSES_ARGUMENT -> FUNCTION (correct)
- ... other cases

**Critical Issue**: When `targetType = 'VARIABLE'` and the variable name matches a FUNCTION name, the code still resolves to VARIABLE node, not FUNCTION.

### Enrichment Phase

**FunctionCallResolver.ts (priority 80)**:
- Only creates CALLS edges for CALL_SITE nodes (direct identifier calls like `foo()`)
- Skips nodes with `object` attribute (method calls)
- Does NOT process PASSES_ARGUMENT edges at all
- Does NOT follow: CALL -> PASSES_ARGUMENT -> VARIABLE -> FUNCTION

**MethodCallResolver.ts (priority 50)**:
- `BUILTIN_PROTOTYPE_METHODS` includes: `forEach`, `map`, `filter`, `reduce`, `then`, `catch`, etc.
- When method is in this set, call is marked as "external" and processing is skipped
- Does NOT create CALLS edges for these builtin methods
- Does NOT inspect arguments passed to these builtins

**ArgumentParameterLinker.ts (priority 45)**:
- Creates RECEIVES_ARGUMENT edges (parameter <- argument)
- Requires CALLS edge to already exist
- Cannot help with unresolved callback calls

## 2. ROOT CAUSE

```
Code: array.forEach(invokeCleanup)

ANALYSIS PHASE creates:
  - CALL node: "forEach" (method call)
  - PASSES_ARGUMENT -> VARIABLE("invokeCleanup")  ← Problem

ENRICHMENT PHASE:
  - MethodCallResolver skips forEach (in BUILTIN_PROTOTYPE_METHODS)
  - No enricher examines PASSES_ARGUMENT edges
  - No enricher follows VARIABLE -> FUNCTION resolution
  - Result: No CALLS edge created
```

## 3. PROPOSAL

### Architecture

New enricher: `CallbackResolver` (priority: 35, after MethodCallResolver)
- Query PASSES_ARGUMENT edges pointing to VARIABLE nodes
- For each, check if variable name exists as FUNCTION in same file
- Create CALLS edge from CALL -> FUNCTION if match found

### Algorithm

1. Build index: Map<file, Map<name, FunctionNode>> — all FUNCTION nodes by file and name
2. For each PASSES_ARGUMENT edge to VARIABLE:
   - Get source CALL node
   - Get variable name
   - Look up in function index: file + variableName
   - If found: CREATE CALLS edge: CALL -> FUNCTION
3. Complexity: O(f + a) where f = functions, a = PASSES_ARGUMENT edges to variables

### Principles Applied

- **Forward registration**: analyzer marks data (existing PASSES_ARGUMENT edges suffice)
- **Enrichment-phase resolution**: cross-file safe, uses existing indices
- **Targeted queries**: not scanning all nodes, only PASSES_ARGUMENT edges

## 4. RISKS

1. **False positives**: Same-name functions in same file — mitigate with scope path
2. **Performance**: Linear complexity, acceptable
3. **Doesn't catch all callbacks**: Variables from imports, reassigned vars — acceptable MVP
4. **Scope**: Same-file only for now; cross-file via FunctionCallResolver pattern later

## 5. PRIOR ART

- WALA (IBM), ACG, Jelly (AU/DK), TAPIR — all struggle with callback resolution
- Most use either conservative (over-approximate) or optimistic (obvious cases) approach
- Grafema should use optimistic: resolve what we can see clearly
