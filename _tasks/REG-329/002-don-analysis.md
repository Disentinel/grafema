# Don Melton Analysis: REG-329 Scope Chain Resolution

## 1. Current Implementation Analysis

### Location and Implementation
The current scope resolution is in `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` at lines 2119-2219:

**Methods:**
- `resolveVariableInScope(name, scopePath, file, variables)` — resolves VARIABLE nodes
- `resolveParameterInScope(name, scopePath, file, parameters)` — resolves PARAMETER nodes
- `scopePathsMatch(a, b)` — compares two scope paths

### How It Works
The implementation uses a **scope chain walk-up algorithm**:

```typescript
// Lines 2136-2162
for (let i = scopePath.length; i >= 0; i--) {
  const searchScopePath = scopePath.slice(0, i);
  const matchingVar = variables.find(v => {
    // Match logic here
  });
  if (matchingVar) return matchingVar;
}
```

This walks from innermost scope (full path) down to module-level (empty array []).

### Key Data Structures

1. **Variable Info** (`VariableDeclarationInfo` in VariableVisitor.ts:57-65):
   - `id`: Variable's semantic ID
   - `name`: Variable name
   - `file`: File path
   - `parentScopeId`: Parent scope identifier
   - `type`: 'VARIABLE' or 'CONSTANT'

2. **Scope Context** (`ScopeContext` in SemanticId.ts:31-37):
   - `file`: Source file path
   - `scopePath`: Array of scope names, e.g., `['handler', 'if#0', 'nested']`

3. **Semantic ID Format** (SemanticId.ts):
   ```
   {file}->{scope_path}->{type}->{name}[#discriminator][{context}]

   Examples:
   - routes.js->global->VARIABLE->API_KEY
   - routes.js->handler->VARIABLE->localVar
   - routes.js->handler->if#0->VARIABLE->tempVar
   ```

### Module-Level Scope Handling (REG-309 Fix)

At lines 2150-2152, there's a special case for module-level variables:

```typescript
if (searchScopePath.length === 0) {
  return parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global';
}
```

This handles the mismatch where:
- **Empty scope path** `[]` (search at module level)
- **Matches** semantic ID with scope `['global']`

## 2. Scope Representation in Grafema

### Scope Nodes
- **Type:** `SCOPE` nodes in graph (ScopeNode.ts)
- **Fields:** `scopeType`, `conditional`, `parentScopeId`, `parentFunctionId`
- **Scope Types:** `if`, `else`, `try`, `catch`, `finally`, `for`, `while`, `switch`

### Scope Hierarchy
```
MODULE (root)
  ├─ SCOPE (if#0)
  ├─ FUNCTION (handler)
  │   ├─ SCOPE (if#0)
  │   ├─ SCOPE (for#1)
  │   └─ VARIABLE (localVar)
  └─ VARIABLE (API_KEY)
```

### Scope Path Representation
- **ScopeTracker** (ScopeTracker.ts) maintains a stack during AST traversal
- **Format:** Array of scope names, e.g., `['handler', 'if#0']`
- **Empty array `[]`** represents module-level

## 3. Current Resolution Issues

### Problem 1: String Prefix Matching (Before REG-309)
Old code used string prefix matching on semantic IDs — this is fragile.

### Problem 2: Module-Level Variables
Variable declared at module scope: `routes.js->global->VARIABLE->API_KEY`
When used in handler at: `routes.js->handler->...`
The search scope path is `['handler']`, and it won't find the variable at `['global']`.

**Fix in REG-309:** Special case for empty search scope `[]` matching `['global']`.

### Problem 3: Shadowing Not Fully Addressed
While scope chain walk-up is correct, the implementation doesn't explicitly validate that inner scope declarations completely shadow outer scope.

## 4. Related Code and Callers

### Direct Callers of Resolution Methods
- **Line 2078-2083:** Array mutations with base object lookup
- **Line 2093-2098:** Array mutation value source lookup
- **Line 2102-2107:** Object mutations with property tracking
- **Line 2122-2127:** Object property mutation source lookup

### Existing Tests
Found in `/test/unit/` but scope resolution tests appear limited. Key test files:
- `FunctionCallResolver.test.ts` — function resolution patterns
- `if-statement-nodes.test.ts` — scope condition handling

## 5. Prior Art and Best Practices

### Industry Standard Approach
- **ESLint/Babel:** Use scope analysis bindings mapping identifier names to Binding objects
- **TypeScript:** Maintains full symbol tables with scope hierarchies
- **Semantic analysis tools:** Track scope chains using **lexical scope** (compile-time)

**Key insight:** Static analysis tools walk **up the scope chain** (as Grafema does) not down.

### Best Practices
1. **Maintain scope stack** during traversal (Grafema has this with ScopeTracker)
2. **Store parent references** for efficient lookup (Grafema has parentScopeId)
3. **Use structured scope representation** not string parsing
4. **Handle special cases** like module-level and closure captures

## 6. Architecture Overview

```
┌─────────────────────────────────────────┐
│ ScopeTracker (AST Traversal)           │
├─────────────────────────────────────────┤
│ • Maintains scope stack                 │
│ • Generates scopePath: ['func', 'if#0'] │
│ • Provides getContext() for IDs         │
└────────────────┬────────────────────────┘
                 │
                 ├─► computeSemanticId()
                 │   → file->scope->TYPE->name
                 │
                 └─► VariableVisitor/FunctionVisitor
                     → Creates nodes with semantic IDs

┌────────────────────────────────────────────┐
│ GraphBuilder (Graph Construction)          │
├────────────────────────────────────────────┤
│ resolveVariableInScope():                  │
│ • Input: name, scopePath[], file           │
│ • Walks: len→0, slicing scopePath each     │
│ • Matches: parseSemanticId().scopePath     │
│ • Returns: First matching variable         │
└────────────────────────────────────────────┘
```

## 7. Known Limitations

1. **Module-level special case** required (scopePath.length === 0 vs ['global']) — fragile
2. **No explicit shadowing validation** — assumes correct semantic IDs
3. **String format dependency** — some legacy code still uses split('#')
4. **No cycle detection** — parentScopeId not used for graph traversal

## 8. Recommendations

### Approach: Consolidate to Graph-Based Resolution
Instead of semantic ID string parsing, use the graph structure:

1. **Index:** Create `parentScopeId` → `SCOPE node` mapping
2. **Walk:** Use `parentScopeId` chain to walk scope hierarchy
3. **Lookup:** Query VARIABLE nodes by scope instead of parsing IDs
4. **Benefits:**
   - Eliminates string format dependency
   - Handles all scope types uniformly
   - Can leverage RFDB indexes

### Key Files to Modify
- `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (lines 2119-2219)
- `/packages/core/src/core/SemanticId.ts` (ID parsing logic)
- `/packages/core/src/core/ScopeTracker.ts` (scope stack management)
- `/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts` (variable tracking)

### Alternative: Minimal Fix
If graph-based resolution is too invasive, improve current approach:
1. Normalize scope paths during analysis (convert [] to ['global'])
2. Add explicit shadowing check
3. Keep the scope chain walk-up algorithm (it's correct)
