# Rob Pike - Implementation Report Update: Control Flow Scope Tracking

## Summary

Continued implementation of semantic IDs for REG-123. Added control flow scope tracking (if/for/while/try) to `analyzeFunctionBody` using Babel's enter/exit pattern. Fixed several issues that caused duplicate or incorrectly scoped nodes.

## Changes Made

### 1. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Major refactoring of control flow handlers to use enter/exit pattern:**

- **IfStatement handler**: Converted from manual traverse with `skip()` to enter/exit pattern
  - `enter`: Creates SCOPE node, calls `scopeTracker.enterCountedScope('if')`
  - `exit`: Calls `scopeTracker.exitScope()`
  - Added if/else branch tracking with `ifElseScopeMap` to switch scopes when entering else block

- **ForStatement handler**: Converted to enter/exit pattern
  - `enter`: Creates SCOPE node, calls `scopeTracker.enterCountedScope('for')`
  - `exit`: Calls `scopeTracker.exitScope()`

- **ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement**: Same pattern

- **TryStatement handler**: Updated with scopeTracker for try/catch/finally blocks
  - Each block gets its own counted scope

- **BlockStatement handler**: Added to detect when entering else branch of IfStatement
  - Switches scopeTracker from 'if' to 'else' scope when appropriate

- **CallExpression handler**: Removed parent type check (was incorrectly filtering)
  - All direct function calls now processed regardless of control flow context

- **NewExpression handler**: Same cleanup

### 2. `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

- **Skip function-internal Identifier calls**: Direct function calls inside functions are now skipped here since they're handled by `analyzeFunctionBody` with proper scope tracking
- **Keep MemberExpression calls**: Method calls still processed here (no duplication issue)

### 3. `/Users/vadimr/grafema/test/unit/VariableVisitorSemanticIds.test.js`

- Fixed test that used `config.js` instead of `index.js` (orchestrator only discovers index.js as entrypoint)

## Test Results

### Before this update
- VariableVisitorSemanticIds: 12 passing, 5 failing
- CallExpressionVisitorSemanticIds: 13 passing, 11 failing
- **Total: 25 passing, 16 failing**

### After this update
- VariableVisitorSemanticIds: **17 passing, 0 failing** (100%)
- CallExpressionVisitorSemanticIds: **18 passing, 6 failing** (75%)
- **Total: 35 passing, 6 failing**

### Fixed Tests
1. Variables inside if blocks (`functionName->if#0->VARIABLE->name`)
2. Variables inside for/while loops
3. Variables inside nested control flow (`function->if#0->for#0->if#0->VARIABLE`)
4. Calls inside if/else branches (with separate `if#0` and `else#0` scopes)
5. Module-level global scope variables

### Still Failing (6 tests)
1. **Method calls inside functions** - `data.process()` gets global scope instead of function scope
   - Requires adding MemberExpression handling to analyzeFunctionBody

2. **Constructor calls (new) inside functions** - Same issue as method calls

3. **Array mutations (4 tests)** - FLOWS_INTO edges not being created
   - `detectArrayMutation()` runs but edges aren't built properly

## Technical Details

### Enter/Exit Pattern vs Manual Traverse

The key insight was that using `path.skip()` with manual traverse prevented proper nested control flow handling. By switching to Babel's enter/exit callbacks:

```typescript
ForStatement: {
  enter: (forPath) => {
    // Create SCOPE, enter scopeTracker
    scopeTracker.enterCountedScope('for');
  },
  exit: () => {
    // Exit scopeTracker
    scopeTracker.exitScope();
  }
}
```

Babel naturally traverses nested structures, and the scopeTracker state is correct at each level.

### If/Else Scope Tracking

Special handling needed because IfStatement contains both consequent and alternate as children:

1. On IfStatement enter: push `if#N` scope
2. Track IfStatement in `ifElseScopeMap`
3. On BlockStatement enter (if it's the alternate of tracked IfStatement): exit `if`, enter `else`
4. On IfStatement exit: exit current scope

### Preventing Duplicate Nodes

CallExpressionVisitor at module level was creating duplicate CALL nodes for function-internal calls. Fixed by:
- Skipping Identifier calls (direct functions) if inside a function - handled by analyzeFunctionBody
- Keeping MemberExpression calls (methods) - not duplicated

## Remaining Work

### Priority 1: Method calls in functions
Need to add MemberExpression handling to `analyzeFunctionBody` similar to how CallExpression is handled. Currently method calls inside functions get processed by CallExpressionVisitor at global scope.

### Priority 2: Constructor calls (new) in functions
Same issue as method calls.

### Priority 3: Array mutations
The `detectArrayMutation()` collects ArrayMutationInfo but edge building needs investigation. The FLOWS_INTO edges might be created elsewhere or have different conditions.

## Build Status

- TypeScript compilation: PASS
- No errors or warnings
