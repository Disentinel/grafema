# REG-534: 1414 variables with no assignment edges (silent fallthrough in trackVariableAssignment)

## Problem

1414 VARIABLE/CONSTANT nodes have no ASSIGNED_FROM, DERIVES_FROM, or FLOWS_INTO edges at all. These are invisible to data flow analysis.

Pattern: `VARIABLE:x → (no assignment edge)`

## Root Cause

`JSASTAnalyzer.trackVariableAssignment()` has 11 expression type branches. Types not covered fall through silently — no edge created, no warning logged.

Likely unhandled types:
- Destructuring patterns (`const { a, b } = obj`)
- Yield expressions (`const x = yield foo()`)
- Await expressions (`const x = await promise`)
- Tagged template literals
- Comma expressions
- Sequence expressions

## Acceptance Criteria

- Audit all expression types in `trackVariableAssignment()`
- Add branches for destructuring, await, yield at minimum
- Add fallback that creates generic ASSIGNED_FROM for truly unknown types
- Target: reduce 1414 → <100
