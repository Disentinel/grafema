# User Request: REG-532

## Task
CALL/CONSTRUCTOR_CALL nodes missing DERIVES_FROM edges to arguments

## Problem
~2800 ERR_NO_LEAF_NODE warnings caused by CALL and CONSTRUCTOR_CALL nodes having no outgoing DERIVES_FROM edges. Data flow tracing stops at the CALL node.

Pattern: `VARIABLE:x → ASSIGNED_FROM → CALL:foo → (dead end)`

## Examples
- `const elapsed = this.formatElapsed()` — CALL has no outgoing edges at all
- `const padded = output.padEnd(...)` — CALL has USES/PASSES_ARGUMENT but no DERIVES_FROM
- `const seen = new Set()` — CONSTRUCTOR_CALL has no outgoing edges

## Breakdown
- CALL → dead end: 2498 cases
- CONSTRUCTOR_CALL → dead end: 296 cases

## Expected
CALL node should have outgoing DERIVES_FROM edges to:
1. Each argument node (data flows into the call)
2. The callee FUNCTION definition (to trace return value)

## Where to Fix
`CallFlowBuilder` or enrichment phase — needs to create DERIVES_FROM edges from CALL back to its inputs.

## MLA Config
Mini-MLA (medium complexity, local scope)
