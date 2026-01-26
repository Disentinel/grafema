# Don Melton - Analysis of Loop Variable Declaration Tracking

## Task Analysis: REG-272

Based on thorough codebase exploration, here's the complete analysis for tracking loop variable declarations in for...of and for...in statements.

## Current State of Variable Tracking

### Variable Declaration Tracking (Module-level)
- **Location:** `/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`
- Only handles module-level `VariableDeclaration` nodes (line 216: `const functionParent = path.getFunctionParent(); if (!functionParent)`)
- Supports destructuring patterns via `extractVariableNamesFromPattern()` method
- Creates VARIABLE or CONSTANT nodes depending on whether `const` + literal/NewExpression

### Variable Declaration Tracking (Function-level)
- **Location:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` lines 1619-1729 (`handleVariableDeclaration()`)
- Handles all VariableDeclarations within function bodies
- Uses `extractVariableNamesFromPattern()` (same as module-level)
- Generates semantic IDs using `ScopeTracker.getContext()`
- Tracks destructuring assignments with `trackDestructuringAssignment()`
- Creates VARIABLE/CONSTANT nodes scoped to `parentScopeId`

### Pattern Extraction
- **Method:** `extractVariableNamesFromPattern()` in JSASTAnalyzer (lines 484-545)
- Recursively handles: `Identifier`, `ObjectPattern`, `ArrayPattern`, `RestElement`, `AssignmentPattern`
- Returns variables with path information but does NOT handle loop-specific cases

## Current State of Loop Handling

### Loop Scope Creation
- **Location:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` lines 1731-1767
- Factory method: `createLoopScopeHandler()` creates handlers for all loop types
- Each loop creates a SCOPE node with `scopeType`: 'for-loop', 'for-of-loop', 'for-in-loop', etc.
- Scope tracker enters/exits counted scope

### The Critical Gap
- Loop handlers ONLY create the SCOPE node
- They do NOT process the `left` property of ForOfStatement/ForInStatement
- Example: `for (const { x, y } of points)` - the `{ x, y }` pattern is completely ignored

## Code Locations That Need Changes

### 1. Primary Change Location
**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- Line 2240-2241: ForInStatement and ForOfStatement handlers
- Current: Only creates loop scope via `createLoopScopeHandler()`
- Need: Add explicit handling for loop variable declarations

### 2. Pattern Reference
Same file:
- Lines 1619-1729: `handleVariableDeclaration()` - shows exact pattern needed
- Lines 484-545: `extractVariableNamesFromPattern()` - reusable helper
- Lines 1706-1727: `trackDestructuringAssignment()` - for destructuring tracking

## Recommended Approach

### Strategy: Enhance Loop Handlers

1. **Modify loop handlers to extract and track `left` variables:**
   - After scope is entered in loop handler
   - Check if `left` is a VariableDeclaration
   - Extract variables using `extractVariableNamesFromPattern()`
   - Create VARIABLE/CONSTANT nodes with loop scope as `parentScopeId`
   - Track assignments (variable DERIVES_FROM the iterable/iterator)

2. **Handle the source collection tracking:**
   - ForOfStatement/ForInStatement have `right` property (the collection)
   - Create assignment tracking so loop variables DERIVES_FROM the collection

3. **Integration:**
   - No changes needed to VariableVisitor (module-level handler)
   - No changes to pattern extraction logic
   - Loop handler needs to be enhanced, not replaced

## Testing Strategy

- Use existing test fixture: `/test/fixtures/04-control-flow/src/loops.js`
- Has `sumWithForOf()` at line 18 (for...of with simple variable)
- Has `processObjectKeys()` at line 29 (for...in with simple variable)
- Add tests for destructuring patterns

## Risk Analysis

**Low Risk:** Pattern already proven in codebase for similar variable tracking.

**Consideration:** Must ensure variables don't get double-created if multiple handlers process same nodes.

## Conclusion

The implementation is straightforward - the infrastructure exists and is working elsewhere. The solution requires enhanced loop handlers using existing `extractVariableNamesFromPattern()` method.
