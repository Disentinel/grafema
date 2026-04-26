# Don Melton - High-Level Plan for REG-142

## Executive Summary

The `analyzeFunctionBody` method in `JSASTAnalyzer.ts` is approximately 920 lines (lines 1262-2182) and handles 17 distinct concerns within a single monolithic `funcPath.traverse()` call. This violates the Single Responsibility Principle and creates a maintenance nightmare.

**Key Insight:** The method structure is fundamentally sound - it uses Babel's traverse pattern with visitor handlers. The problem is that ALL handlers are inlined in one massive object literal instead of being extracted into focused methods.

## Current Structure Analysis

### Lines 1262-1311: Setup (50 lines)
- Extract collections from `VisitorCollections` with defaults
- Initialize `parentScopeVariables` and `ifElseScopeMap`
- This setup code is necessary boilerplate but can be partially simplified

### Lines 1312-2181: The Traverse Block (~870 lines)
Contains 17 visitor handlers:

| Handler | Lines | Complexity | Notes |
|---------|-------|------------|-------|
| VariableDeclaration | ~70 | Medium | ID generation, constant detection, tracking |
| AssignmentExpression | ~20 | Low | Delegates to detect* methods |
| ForStatement | ~27 | Low | Scope enter/exit pattern |
| ForInStatement | ~25 | Low | Identical pattern to For |
| ForOfStatement | ~25 | Low | Identical pattern to For |
| WhileStatement | ~25 | Low | Identical pattern to For |
| DoWhileStatement | ~25 | Low | Identical pattern to For |
| **TryStatement** | **~210** | **HIGH** | try/catch/finally with nested traversals |
| SwitchStatement | ~15 | Low | Simple scope creation |
| FunctionExpression | ~45 | Medium | Nested function + recursive call |
| ArrowFunctionExpression | ~60 | Medium | Nested function + recursive call |
| UpdateExpression | ~25 | Low | Variable modification tracking |
| **IfStatement** | **~70** | **Medium** | Scope transitions, constraint parsing |
| BlockStatement | ~15 | Low | Else branch detection |
| **CallExpression** | **~110** | **HIGH** | Direct calls + method calls + mutations |
| NewExpression | ~75 | Medium | Constructor calls |

## Extraction Strategy

### Priority 1: TryStatement Handler (HIGHEST IMPACT)
**Lines: ~210, Complexity: HIGH**

Extract to: `handleTryStatement(tryPath, parentScopeId, module, collections, scopeTracker)`

**Why first:**
- Largest single handler (210+ lines)
- Contains THREE nested `traverse()` calls (try, catch, finally blocks)
- Each nested traverse duplicates VariableDeclaration handling logic
- Has significant complexity with catch parameter handling

**Approach:**
1. Extract main handler method
2. Extract shared `processBlockVariables()` helper (used by try/catch/finally)
3. This alone reduces main method by ~200 lines

### Priority 2: Loop Scope Handlers (DRY VIOLATION)
**Lines: ~125 combined, Complexity: LOW**

Extract to: `createLoopScopeHandler(loopType: string, scopeType: string)`

**Why second:**
- ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement
- ALL five handlers are nearly identical (copy-paste with different strings)
- Perfect candidate for factory method pattern

**Before:**
```typescript
ForStatement: { enter: (forPath) => {...}, exit: () => {...} },
ForInStatement: { enter: (forPath) => {...}, exit: () => {...} },
// ... 3 more identical patterns
```

**After:**
```typescript
ForStatement: this.createLoopScopeHandler('for', 'for-loop'),
ForInStatement: this.createLoopScopeHandler('for-in', 'for-in-loop'),
// ... etc
```

**Reduction:** ~125 lines -> ~10 lines in main method + ~30 line factory

### Priority 3: CallExpression Handler (HIGH COMPLEXITY)
**Lines: ~110, Complexity: HIGH**

Extract to: `handleCallExpression(callPath, parentScopeId, module, collections, scopeTracker, processedNodes)`

**Why third:**
- Second most complex handler
- Handles two distinct patterns: direct calls and method calls
- Contains array/object mutation detection logic

**Approach:**
1. Extract main handler
2. Possibly extract `handleDirectCall()` and `handleMethodCall()` sub-methods

### Priority 4: IfStatement Handler (SCOPE TRANSITIONS)
**Lines: ~70, Complexity: MEDIUM**

Extract to: `handleIfStatement` with enter/exit methods

**Why fourth:**
- Has complex scope transition logic with `ifElseScopeMap`
- Constraint parsing with ConditionParser
- State machine behavior (tracking if->else transitions)

### Priority 5: VariableDeclaration Handler
**Lines: ~70, Complexity: MEDIUM**

Extract to: `handleVariableDeclaration(varPath, parentScopeId, module, collections, scopeTracker)`

**Why fifth:**
- Moderate complexity with constant detection logic
- Has class instantiation tracking
- Variable assignment tracking

### Priority 6: Nested Function Handlers (FunctionExpression + ArrowFunctionExpression)
**Lines: ~105 combined, Complexity: MEDIUM**

Can potentially share logic via:
`handleNestedFunction(funcPath, funcName, isArrow, parentScopeId, module, collections, scopeCtx)`

## Proposed Method Signatures

```typescript
// Priority 1 - TryStatement
private handleTryStatement(
  tryPath: NodePath<t.TryStatement>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeTracker?: ScopeTracker,
  scopeCtx?: ScopeContext
): void;

private processBlockVariables(
  blockPath: NodePath,
  scopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeTracker?: ScopeTracker
): void;

// Priority 2 - Loop Factory
private createLoopScopeHandler(
  trackerScopeType: string,  // 'for', 'for-in', 'while', etc.
  scopeType: string          // 'for-loop', 'for-in-loop', etc.
): {
  enter: (path: NodePath) => void;
  exit: () => void;
};

// Priority 3 - CallExpression
private handleCallExpression(
  callPath: NodePath<t.CallExpression>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeTracker?: ScopeTracker,
  processedNodes: ProcessedNodes
): void;

// Priority 4 - IfStatement
private handleIfStatementEnter(
  ifPath: NodePath<t.IfStatement>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeTracker?: ScopeTracker,
  scopeCtx?: ScopeContext,
  ifElseScopeMap: Map<t.IfStatement, { inElse: boolean; hasElse: boolean }>
): void;

private handleIfStatementExit(
  ifPath: NodePath<t.IfStatement>,
  scopeTracker?: ScopeTracker,
  ifElseScopeMap: Map<t.IfStatement, { inElse: boolean; hasElse: boolean }>
): void;

// Priority 5 - VariableDeclaration
private handleVariableDeclaration(
  varPath: NodePath<t.VariableDeclaration>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeTracker?: ScopeTracker,
  parentScopeVariables: Set<{ name: string; id: string; scopeId: string }>
): void;

// Priority 6 - Nested Functions (optional consolidation)
private handleNestedFunctionExpression(
  funcPath: NodePath<t.FunctionExpression>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeCtx?: ScopeContext
): void;

private handleNestedArrowFunction(
  arrowPath: NodePath<t.ArrowFunctionExpression>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeCtx?: ScopeContext
): void;
```

## Risks and Considerations

### 1. Closure Variables
The traverse handlers use many closure variables from `analyzeFunctionBody`:
- `parentScopeVariables` - local Set
- `ifElseScopeMap` - local Map for state
- `processedCallSites`, `processedVarDecls`, etc. - from processedNodes
- All the extracted collection arrays

**Mitigation:** Pass these as parameters or create a context object.

### 2. Recursive Calls
`FunctionExpression` and `ArrowFunctionExpression` handlers call `this.analyzeFunctionBody()` recursively. The extracted methods must maintain this capability.

**Mitigation:** Ensure extracted methods are instance methods with access to `this`.

### 3. Traverse Skip Behavior
Several handlers call `path.skip()` or `tryPath.skip()` to prevent re-traversal. This must be preserved.

**Mitigation:** Document and test skip behavior explicitly.

### 4. Test Coverage
The current test coverage for `analyzeFunctionBody` appears limited (only found in `ClassVisitorClassNode.test.js`).

**Mitigation:** Write characterization tests BEFORE refactoring to lock current behavior.

## Execution Plan Summary

| Phase | Handler(s) | Lines Reduced | New Methods |
|-------|------------|---------------|-------------|
| 1 | TryStatement | ~200 | handleTryStatement, processBlockVariables |
| 2 | Loop Handlers (5) | ~100 | createLoopScopeHandler |
| 3 | CallExpression | ~100 | handleCallExpression |
| 4 | IfStatement | ~60 | handleIfStatementEnter/Exit |
| 5 | VariableDeclaration | ~60 | handleVariableDeclaration |
| 6 | Nested Functions | ~40 | handleNestedFunction* |

**Total Reduction:** ~560 lines from main method
**Result:** `analyzeFunctionBody` shrinks from ~920 lines to ~360 lines

## Acceptance Criteria Mapping

- [x] Extract at least 5 handler methods - We're extracting 8+ methods
- [x] Each method < 150 lines - All extracted methods will be <150 lines
- [x] No behavior change - Pure refactoring with characterization tests
- [x] All tests pass - Tests written first, maintained throughout

## Recommendation

**Start with Priority 1 (TryStatement)** - it's the biggest win and the most isolated. It has its own nested traversals so extracting it doesn't require changes to other handlers.

**DO NOT attempt to extract all at once.** Each extraction should be:
1. One commit
2. Fully tested
3. Reviewed before moving to next

This is a refactoring, not a rewrite. The goal is identical behavior with better structure.
