# Don Melton Analysis: REG-141

## Codebase Analysis

### analyzeFunctionBody Location

**Primary definition:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts:1262`

```typescript
analyzeFunctionBody(
  funcPath: NodePath<t.Function>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeCtx?: ScopeContext  // <-- LEGACY PARAMETER TO REMOVE
): void
```

### Current scopeCtx Usage

**Type definition (legacy, local to JSASTAnalyzer):** `JSASTAnalyzer.ts:99-102`
```typescript
interface ScopeContext {
  semanticPath: string;                    // "ClassName.method" or "funcName"
  siblingCounters: Map<string, number>;    // scopeType -> count for this level
}
```

**What scopeCtx is used for inside analyzeFunctionBody:**

1. **`generateSemanticId()` calls** - generates stable IDs for scopes (lines 1413, 1441, 1468, 1495, 1522, 1549, 1611, 1695, 1762, 1798, 1857, 1917, 1945)
   - For: for-loop, for-in-loop, for-of-loop, while-loop, do-while-loop, try-block, catch-block, finally-block, switch-case, closure, arrow_body, if_statement, else_statement

2. **`generateAnonymousName()` calls** - generates unique names for anonymous functions (lines 1777, 1833)
   - Used when nested FunctionExpression or ArrowFunctionExpression has no name

3. **Building child ScopeContext for nested functions** (lines 1813-1816, 1872-1875)
   - Creates new context with `scopeCtx.semanticPath` as prefix

### Current scopeTracker Usage

**Type:** `ScopeTracker` from `/Users/vadimr/grafema/packages/core/src/core/ScopeTracker.ts`

**What scopeTracker is used for inside analyzeFunctionBody:**

1. **`enterCountedScope()`** - enters scope with auto-incrementing discriminator (lines 1426, 1454, 1481, 1508, 1535, 1562, 1624, etc.)
   - For: for, for-in, for-of, while, do-while, try, catch, if

2. **`exitScope()`** - exits current scope (lines 1432, 1459, 1486, 1513, 1540, 1605, etc.)

3. **`getContext()`** - returns `ScopeContext` for `computeSemanticId()` calls
   - Used for VARIABLE/CONSTANT IDs (lines 1331-1333, 1582-1584, 1634-1636, etc.)
   - Used for FUNCTION IDs (lines 1780-1782, 1838-1840)

### All Callers of analyzeFunctionBody

**In JSASTAnalyzer.ts (calling `this.analyzeFunctionBody`):**

1. **Line 1037** - module-level function in AssignmentExpression handler
   ```typescript
   this.analyzeFunctionBody(funcPath, funcBodyScopeId, module, allCollections, funcScopeCtx);
   ```

2. **Line 1111** - callback detection at module level
   ```typescript
   this.analyzeFunctionBody(funcPath, callbackScopeId, module, allCollections, callbackScopeCtx);
   ```

3. **Line 1817** - nested FunctionExpression inside function body
   ```typescript
   this.analyzeFunctionBody(funcPath, nestedScopeId, module, collections, nestedFuncCtx);
   ```

4. **Line 1876** - nested ArrowFunctionExpression inside function body
   ```typescript
   this.analyzeFunctionBody(arrowPath, nestedScopeId, module, collections, arrowFuncCtx);
   ```

**In Visitors (calling injected `analyzeFunctionBody` callback):**

5. **FunctionVisitor.ts:337** - FunctionDeclaration
   ```typescript
   analyzeFunctionBody(path as NodePath<FunctionDeclaration>, functionBodyScopeId, module, collections);
   ```

6. **FunctionVisitor.ts:418** - ArrowFunctionExpression
   ```typescript
   analyzeFunctionBody(path as NodePath<ArrowFunctionExpression>, bodyScope, module, collections);
   ```

7. **ClassVisitor.ts:288** - class property with arrow/function value
   ```typescript
   analyzeFunctionBody(funcPath, propBodyScopeId, module, collections);
   ```

8. **ClassVisitor.ts:359** - ClassMethod
   ```typescript
   analyzeFunctionBody(methodPath, methodBodyScopeId, module, collections);
   ```

**Key observation:** The Visitors already call `analyzeFunctionBody` WITHOUT the `scopeCtx` parameter! They pass only 4 arguments, not 5.

### generateSemanticId Analysis

**Definition:** `JSASTAnalyzer.ts:1226-1235`

```typescript
private generateSemanticId(
  scopeType: string,
  scopeCtx: ScopeContext | undefined
): string | undefined {
  if (!scopeCtx) return undefined;

  const siblingIndex = scopeCtx.siblingCounters.get(scopeType) || 0;
  scopeCtx.siblingCounters.set(scopeType, siblingIndex + 1);
  return `${scopeCtx.semanticPath}:${scopeType}[${siblingIndex}]`;
}
```

**Can it be removed?**

YES, but with caveats:
- The result is used to populate `semanticId` field in `ScopeInfo` objects
- Currently `scopeTracker.enterCountedScope()` provides similar discriminators
- The format differs: `generateSemanticId` produces `path:type[N]`, while `computeSemanticId` uses `TYPE@file/path::scopePath#N`

**The problem:**
- `generateSemanticId` produces OLD format semantic IDs for SCOPE nodes
- `computeSemanticId` (using scopeTracker) produces NEW format
- Both exist in parallel, creating inconsistency

## Risk Assessment

### Low Risk
- **Visitors already don't pass scopeCtx** - they call with 4 args, meaning scopeCtx is `undefined` in those paths
- **Parameter is optional** - changing to required 4 args won't break type signatures

### Medium Risk
- **JSASTAnalyzer internal calls DO pass scopeCtx** - these need updating
- **Module-level if/else also uses generateSemanticId** (lines 1137, 1158) - outside analyzeFunctionBody but same pattern

### Key Insight
**Two different `ScopeContext` types exist:**
1. **Legacy local:** `JSASTAnalyzer.ts:99-102` - with `semanticPath` and `siblingCounters`
2. **New standard:** `SemanticId.ts:32-37` - with `file` and `scopePath[]`

The `scopeTracker.getContext()` returns the NEW type, not the legacy type!

### Edge Cases
1. When `scopeTracker` is undefined (legacy code paths) - currently falls back to legacy IDs
2. Anonymous function naming - currently uses scopeCtx.siblingCounters for stability
3. Nested function context building - uses scopeCtx.semanticPath as prefix

## High-Level Plan

### Phase 1: Replace Legacy Helper Usage (inside analyzeFunctionBody)

1. **Replace `generateSemanticId()` calls with `scopeTracker` equivalent**
   - Use `scopeTracker.enterCountedScope()` + `computeSemanticId()` pattern
   - This already happens for some scope types (for, while, try, etc.)
   - Need to ensure semantic IDs are generated BEFORE entering scope

2. **Replace `generateAnonymousName()` with `scopeTracker.getSiblingIndex()`**
   - ScopeTracker already has `getSiblingIndex(name)` method
   - Change: `this.generateAnonymousName(scopeCtx)` -> `anonymous[scopeTracker.getSiblingIndex('anonymous')]`

3. **Remove `createChildScopeContext()` helper**
   - No longer needed after scopeCtx removal

### Phase 2: Update Callers in JSASTAnalyzer

1. **Lines 1037, 1111** - Remove scopeCtx construction and passing
2. **Lines 1817, 1876** - Remove nested context construction and passing

### Phase 3: Remove Legacy Code

1. **Remove `scopeCtx` parameter from method signature**
2. **Remove `ScopeContext` interface** (local to JSASTAnalyzer)
3. **Remove `generateSemanticId()` private method**
4. **Remove `generateAnonymousName()` private method**
5. **Remove `createChildScopeContext()` private method**

### Phase 4: Update Module-Level Code

1. **Lines 1137, 1158** - Module-level if/else semantic ID generation
   - Same pattern as inside analyzeFunctionBody, needs same treatment

### Phase 5: Verify

1. Run all tests
2. Compare output before/after to ensure no semantic ID format changes
3. Verify no undefined semantic IDs appear

## Recommendation

**Mini-MLA** (Don -> Rob -> Linus)

**Reasoning:**
- This is a well-scoped refactoring within one file
- Clear boundaries - all changes in JSASTAnalyzer.ts
- No external API changes (Visitors already don't use scopeCtx)
- Pattern is already established (scopeTracker usage exists alongside scopeCtx)
- Medium complexity - multiple call sites but repetitive pattern

**Not Full MLA because:**
- No architectural decisions needed
- Pattern already exists in codebase
- Tests already exist for the functionality

**Not Single Agent because:**
- Multiple interconnected changes
- Need to verify no semantic ID format regression
- Could break tests if done incorrectly
