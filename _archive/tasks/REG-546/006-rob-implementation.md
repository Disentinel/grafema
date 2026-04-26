# REG-546: Implementation Report

## Changes Made

### File 1: `packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

**Line 253** (shouldBeConstant): Removed `isNewExpression` from the condition.

```ts
// Before:
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
// After:
const shouldBeConstant = isConst && (isLoopVariable || isLiteral);
```

**Lines 279-305**: Moved `classInstantiations.push()` block from inside the `if (shouldBeConstant)` branch to after the entire if/else block. This ensures INSTANCE_OF edges are created for NewExpression initializers regardless of whether the node is CONSTANT or VARIABLE.

### File 2: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Line 2084** (shouldBeConstant): Same change as above.

```ts
// Before:
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
// After:
const shouldBeConstant = isConst && (isLoopVariable || isLiteral);
```

**Lines 2117-2140**: Moved `classInstantiations.push()` block from inside the `if (shouldBeConstant)` branch to after the if/else block. Preserved the Babel type-guard style (`t.isNewExpression(init) && t.isIdentifier(init.callee)`) matching the existing code convention in this file.

## Snapshots Updated

Updated via `UPDATE_SNAPSHOTS=true node --test test/unit/GraphSnapshot.test.js`.

Two snapshot files changed:
- `test/snapshots/03-complex-async.snapshot.json` — 9 nodes flipped CONSTANT to VARIABLE, plus cascading ID/edge reference updates
- `test/snapshots/07-http-requests.snapshot.json` — additional nodes flipped

All 6 snapshot tests pass after update.

## Build Status

Build succeeded (all packages: core, cli, mcp, api, rfdb, rfdb-server, vscode).

## Test Results

```
# tests 2204
# suites 938
# pass 2177
# fail 0
# cancelled 0
# skipped 5
# todo 22
```

All 2177 tests pass, 0 failures.
