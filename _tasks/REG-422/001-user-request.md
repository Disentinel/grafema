# REG-422: Refactor JSASTAnalyzer.ts — Extract Function Body Handlers

## Task

Decompose JSASTAnalyzer.ts (6,203 lines) by extracting `analyzeFunctionBody` (1,444 lines) into 8 separate handler classes + context object.

## Current State

- `analyzeFunctionBody` — 1,444 lines with 22 inline handlers
- 45 local variables shared through closures
- 6 `create*Handler` methods (~1,300 lines) with 8-14 parameters each
- Total ~2,750 lines to decompose

## Plan (from Uncle Bob Review in REG-331)

### Step 1: FunctionBodyContext
- Interface with all 45 variables
- `createFunctionBodyContext()` factory
- Separate interfaces: ControlFlowState, IfElseScopeInfo, TryScopeInfo

### Step 2: FunctionBodyHandler base + AnalyzerDelegate
- Base class with `getHandlers(): VisitorHandlers`
- AnalyzerDelegate interface for callbacks

### Steps 3-10: Extract handlers (one per commit)
- ReturnYieldHandler, ThrowHandler, VariableHandler, NestedFunctionHandler
- PropertyAccessHandler, NewExpressionHandler, CallExpressionHandler, ControlFlowHandler

### Step 11: Rewrite analyzeFunctionBody (~25 lines)
### Step 12: Cleanup

## Acceptance Criteria

- analyzeFunctionBody < 50 lines
- Each handler in separate file < 350 lines
- Max 3-4 constructor params (ctx + analyzer)
- All snapshot tests pass (graph identity)
- All existing unit tests pass
- create*Handler methods removed from JSASTAnalyzer

## Target: JSASTAnalyzer 6,203 → ~2,000 lines
